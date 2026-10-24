import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { createApi } from "../src/api.js";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { hashToken, mintToken, SESSION_COOKIE, SESSION_TTL_MS } from "../src/auth/session.js";
import { clearSessionCache } from "../src/auth/middleware.js";
import { parseWebhook, pineLabsClient, verifyWebhook, type PineLabsClient } from "../src/billing/pinelabs.js";

const ORIGIN = "http://localhost:4000";
const SECRET = Buffer.from("webhook-secret-bytes").toString("base64");

function sign(id: string, ts: number, body: string, secret = SECRET): string {
  return "v1," + createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${ts}.${body}`).digest("base64");
}

let store: Store;
let userId: string;
let cookie: string;

beforeEach(async () => {
  clearSessionCache();
  store = memoryStore();
  const user = await store.createUser("payer@example.com", "unused");
  userId = user.id;
  const token = mintToken();
  await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  cookie = `${SESSION_COOKIE}=${token}`;
});

function fakeGateway(status = "PROCESSED") {
  const created: unknown[] = [];
  const client: PineLabsClient = {
    createCheckout: async (req) => { created.push(req); return { redirectUrl: "https://pluraluat.v2.pinepg.in/checkout/abc", orderId: "ord-1" }; },
    getOrder: async (orderId) => ({ orderId, merchantRef: null, status }),
  };
  return { client, created };
}

describe("verifyWebhook", () => {
  const body = JSON.stringify({ event_type: "ORDER_PROCESSED", data: { order_id: "ord-1" } });
  const now = 1_790_000_000;

  it("accepts a correct v1 signature, including one among several", () => {
    expect(verifyWebhook({ id: "msg-1", timestamp: String(now), signature: sign("msg-1", now, body) }, body, SECRET, now)).toBe(true);
    expect(verifyWebhook({ id: "msg-1", timestamp: String(now), signature: `v1,AAAA ${sign("msg-1", now, body)}` }, body, SECRET, now)).toBe(true);
    expect(verifyWebhook({ id: "msg-1", timestamp: String(now), signature: sign("msg-1", now, body) }, body, "whsec_" + SECRET, now)).toBe(true);
  });

  it("refuses a tampered body, a wrong secret, a missing header and a stale timestamp", () => {
    const sig = sign("msg-1", now, body);
    expect(verifyWebhook({ id: "msg-1", timestamp: String(now), signature: sig }, body + " ", SECRET, now)).toBe(false);
    expect(verifyWebhook({ id: "msg-1", timestamp: String(now), signature: sign("msg-1", now, body, Buffer.from("other").toString("base64")) }, body, SECRET, now)).toBe(false);
    expect(verifyWebhook({ id: null, timestamp: String(now), signature: sig }, body, SECRET, now)).toBe(false);
    expect(verifyWebhook({ id: "msg-1", timestamp: String(now), signature: sig }, body, SECRET, now + 3600)).toBe(false);
  });

  it("reads the event type, order and merchant reference", () => {
    expect(parseWebhook(JSON.stringify({ event_type: "ORDER_PROCESSED", data: { order_id: "o", merchant_order_reference: "qp-1", status: "PROCESSED" } })))
      .toEqual({ type: "ORDER_PROCESSED", orderId: "o", merchantRef: "qp-1", status: "PROCESSED" });
    expect(parseWebhook("not json")).toBeNull();
  });
});

describe("pineLabsClient", () => {
  it("gets a token once, creates a ₹99 order in paisa, and reads the redirect URL", async () => {
    const calls: { url: string; body?: unknown; auth?: string }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined, auth: headers.authorization });
      if (url.endsWith("/api/auth/v1/token")) return new Response(JSON.stringify({ access_token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }));
      return new Response(JSON.stringify({ token: "t", order_id: "v1-ord", redirect_url: "https://pay/redirect" }));
    }) as unknown as typeof fetch;
    const client = pineLabsClient({ baseUrl: "https://uat", clientId: "id", clientSecret: "sec" }, fakeFetch);
    const req = { merchantRef: "qp-1", amountPaisa: 9900, callbackUrl: "https://api/ret", failureUrl: "https://api/ret?failed=1", email: "a@b.c", customerId: "u1" };
    expect(await client.createCheckout(req)).toEqual({ redirectUrl: "https://pay/redirect", orderId: "v1-ord" });
    await client.createCheckout(req);
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    expect(calls[1]).toMatchObject({ url: "https://uat/api/checkout/v1/orders", auth: "Bearer tok", body: { merchant_order_reference: "qp-1", order_amount: { value: 9900, currency: "INR" }, integration_mode: "REDIRECT" } });
  });

  it("surfaces the gateway's error body", async () => {
    const fakeFetch = (async () => new Response("invalid client", { status: 401 })) as unknown as typeof fetch;
    const client = pineLabsClient({ baseUrl: "https://uat", clientId: "id", clientSecret: "bad" }, fakeFetch);
    await expect(client.getOrder("o")).rejects.toThrow(/401: invalid client/);
  });
});

describe("payment routes", () => {
  const headers = () => ({ cookie, "content-type": "application/json" });

  it("answers 503 when payments are not configured", async () => {
    const app = createApi({ store, start: () => ({ runId: "x" }), payments: null });
    expect((await app.request(`${ORIGIN}/checkout`, { method: "POST", headers: headers() })).status).toBe(503);
  });

  it("opens a checkout for ₹99 and grants exactly one credit however many times Pine Labs confirms it", async () => {
    const { client, created } = fakeGateway();
    const app = createApi({ store, start: () => ({ runId: "x" }), payments: { client, webhookSecret: SECRET } });
    const res = await app.request(`${ORIGIN}/checkout`, { method: "POST", headers: headers() });
    expect(res.status).toBe(200);
    const { ref, redirectUrl } = await res.json();
    expect(redirectUrl).toBe("https://pluraluat.v2.pinepg.in/checkout/abc");
    expect(created[0]).toMatchObject({ merchantRef: ref, amountPaisa: 9900, email: "payer@example.com" });
    expect((await (await app.request(`${ORIGIN}/payments/${ref}`, { headers: headers() })).json()).status).toBe("created");

    const body = JSON.stringify({ event_type: "ORDER_PROCESSED", data: { order_id: "ord-1", merchant_order_reference: ref, status: "PROCESSED" } });
    const deliver = (id: string) => {
      const ts = Math.floor(Date.now() / 1000);
      return app.request(`${ORIGIN}/webhooks/pinelabs`, { method: "POST", body, headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sign(id, ts, body) } });
    };
    expect((await deliver("m1")).status).toBe(200);
    expect((await deliver("m1")).status).toBe(200);
    expect(await store.getWallet(userId)).toEqual({ freeRunUsed: false, paidCredits: 1 });
    expect((await (await app.request(`${ORIGIN}/payments/${ref}`, { headers: headers() })).json()).status).toBe("paid");

    // The browser coming back afterwards changes nothing.
    const back = await app.request(`${ORIGIN}/checkout/return?ref=${ref}`);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`http://localhost:3000/runs/new?payment=paid&ref=${ref}`);
    expect((await store.getWallet(userId)).paidCredits).toBe(1);
  });

  it("refuses an unsigned webhook and grants nothing", async () => {
    const { client } = fakeGateway();
    const app = createApi({ store, start: () => ({ runId: "x" }), payments: { client, webhookSecret: SECRET } });
    const { ref } = await (await app.request(`${ORIGIN}/checkout`, { method: "POST", headers: headers() })).json();
    const body = JSON.stringify({ event_type: "ORDER_PROCESSED", data: { merchant_order_reference: ref } });
    const res = await app.request(`${ORIGIN}/webhooks/pinelabs`, { method: "POST", body, headers: { "webhook-id": "m", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,forged" } });
    expect(res.status).toBe(401);
    expect((await store.getWallet(userId)).paidCredits).toBe(0);
  });

  it("settles on the browser return by asking Pine Labs, not by trusting the browser", async () => {
    const paid = fakeGateway("PROCESSED");
    const app = createApi({ store, start: () => ({ runId: "x" }), payments: { client: paid.client, webhookSecret: SECRET } });
    const { ref } = await (await app.request(`${ORIGIN}/checkout`, { method: "POST", headers: headers() })).json();
    const back = await app.request(`${ORIGIN}/checkout/return?ref=${ref}&status=PROCESSED`);
    expect(back.headers.get("location")).toContain("payment=paid");
    expect((await store.getWallet(userId)).paidCredits).toBe(1);

    const pending = fakeGateway("PENDING");
    const app2 = createApi({ store, start: () => ({ runId: "x" }), payments: { client: pending.client, webhookSecret: SECRET } });
    const second = await (await app2.request(`${ORIGIN}/checkout`, { method: "POST", headers: headers() })).json();
    const back2 = await app2.request(`${ORIGIN}/checkout/return?ref=${second.ref}&status=PROCESSED`);
    expect(back2.headers.get("location")).toContain("payment=pending");
    expect((await store.getWallet(userId)).paidCredits).toBe(1);
  });

  it("hides another account's payment", async () => {
    const { client } = fakeGateway();
    const app = createApi({ store, start: () => ({ runId: "x" }), payments: { client, webhookSecret: SECRET } });
    await store.insertPayment({ id: "qp-other", userId: "someone-else", amountPaisa: 9900, status: "created", createdAt: new Date().toISOString() });
    expect((await app.request(`${ORIGIN}/payments/qp-other`, { headers: headers() })).status).toBe(404);
  });
});
