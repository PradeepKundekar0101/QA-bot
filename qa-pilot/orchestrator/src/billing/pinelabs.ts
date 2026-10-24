import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Pine Labs Online (formerly Plural) hosted checkout: a token from client credentials, an
 * order that hands back a redirect URL, a signed webhook when the order is paid, and an order
 * lookup as the fallback when the webhook is slow. Docs:
 * https://www.pinelabs.com/docs/online-payments/hosted-checkout/integration-steps
 *
 * Amounts are in paisa. The response fields are read defensively (several spellings) because
 * the docs show more than one shape; every unexpected answer is surfaced with its body.
 */
export type PineLabsConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** The webhook secret from the dashboard, base64 (an optional `whsec_` prefix is accepted). */
  webhookSecret?: string;
};

export const PINELABS_UAT = "https://pluraluat.v2.pinepg.in";

export function pineLabsFromEnv(env: NodeJS.ProcessEnv = process.env): PineLabsConfig | null {
  const { PINELABS_CLIENT_ID: clientId, PINELABS_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) return null;
  return { baseUrl: (env.PINELABS_BASE_URL ?? PINELABS_UAT).replace(/\/$/, ""), clientId, clientSecret, webhookSecret: env.PINELABS_WEBHOOK_SECRET };
}

export class PineLabsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PineLabsError";
  }
}

export type CheckoutRequest = {
  merchantRef: string;
  amountPaisa: number;
  callbackUrl: string;
  failureUrl: string;
  email: string;
  customerId: string;
};

export type OrderStatus = "CREATED" | "PENDING" | "ATTEMPTED" | "AUTHORIZED" | "PROCESSED" | "FAILED" | "CANCELLED" | "FULLY_REFUNDED" | "PARTIALLY_REFUNDED" | string;

export interface PineLabsClient {
  createCheckout(req: CheckoutRequest): Promise<{ redirectUrl: string; orderId: string | null }>;
  getOrder(orderId: string): Promise<{ orderId: string; merchantRef: string | null; status: OrderStatus }>;
}

export function pineLabsClient(cfg: PineLabsConfig, fetchImpl: typeof fetch = fetch): PineLabsClient {
  let token: { value: string; expiresAt: number } | null = null;

  const headers = () => ({ "content-type": "application/json", accept: "application/json", "Request-ID": randomUUID(), "Request-Timestamp": new Date().toISOString() });

  async function json(res: Response, what: string): Promise<Record<string, unknown>> {
    const text = await res.text();
    if (!res.ok) throw new PineLabsError(`${what}: Pine Labs answered ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new PineLabsError(`${what}: Pine Labs answered with something that is not JSON: ${text.slice(0, 200)}`);
    }
  }

  async function bearer(): Promise<string> {
    // Refreshed half a minute early, so a token never expires mid-request.
    if (token && token.expiresAt - 30_000 > Date.now()) return token.value;
    const res = await fetchImpl(`${cfg.baseUrl}/api/auth/v1/token`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await json(res, "token");
    const value = body.access_token;
    if (typeof value !== "string") throw new PineLabsError("token: no access_token in the answer");
    const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at)
      : typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000
      : Date.now() + 10 * 60_000;
    token = { value, expiresAt: Number.isNaN(expiresAt) ? Date.now() + 10 * 60_000 : expiresAt };
    return value;
  }

  return {
    async createCheckout(req) {
      const res = await fetchImpl(`${cfg.baseUrl}/api/checkout/v1/orders`, {
        method: "POST",
        headers: { ...headers(), authorization: `Bearer ${await bearer()}` },
        body: JSON.stringify({
          merchant_order_reference: req.merchantRef,
          order_amount: { value: req.amountPaisa, currency: "INR" },
          integration_mode: "REDIRECT",
          pre_auth: false,
          allowed_payment_methods: ["CARD", "UPI", "NETBANKING", "WALLET"],
          callback_url: req.callbackUrl,
          failure_callback_url: req.failureUrl,
          notes: "qa-pilot paid run",
          purchase_details: { customer: { email_id: req.email, customer_id: req.customerId } },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await json(res, "create order");
      const data = (body.data as Record<string, unknown> | undefined) ?? body;
      const redirectUrl = data.redirect_url ?? data.checkout_url ?? body.redirect_url;
      if (typeof redirectUrl !== "string") throw new PineLabsError(`create order: no redirect_url in the answer: ${JSON.stringify(body).slice(0, 300)}`);
      const orderId = data.order_id ?? data.orderId ?? null;
      return { redirectUrl, orderId: typeof orderId === "string" ? orderId : null };
    },

    async getOrder(orderId) {
      const res = await fetchImpl(`${cfg.baseUrl}/api/pay/v1/orders/${encodeURIComponent(orderId)}`, {
        headers: { ...headers(), authorization: `Bearer ${await bearer()}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await json(res, "get order");
      const data = (body.data as Record<string, unknown> | undefined) ?? body;
      return {
        orderId: String(data.order_id ?? orderId),
        merchantRef: typeof data.merchant_order_reference === "string" ? data.merchant_order_reference : null,
        status: String(data.status ?? "UNKNOWN"),
      };
    },
  };
}

/** How old a webhook delivery may be before it is refused as a replay. */
export const WEBHOOK_TOLERANCE_S = 5 * 60;

/**
 * Verifies a webhook the Standard Webhooks way, which is what Pine Labs signs with: HMAC-SHA256
 * over `${id}.${timestamp}.${rawBody}`, keyed with the base64-decoded secret, sent base64 in
 * `webhook-signature` as one or more space-separated `v1,<sig>` entries. The raw body has to
 * be the exact bytes received, so it is read before any JSON parsing.
 */
export function verifyWebhook(
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  rawBody: string,
  secret: string,
  nowS: number = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > WEBHOOK_TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signature.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** The fields of a webhook delivery the API acts on. */
export type WebhookEvent = { type: string; orderId: string | null; merchantRef: string | null; status: string | null };

export function parseWebhook(rawBody: string): WebhookEvent | null {
  try {
    const body = JSON.parse(rawBody) as { event_type?: string; data?: Record<string, unknown> };
    const data = body.data ?? {};
    return {
      type: String(body.event_type ?? ""),
      orderId: typeof data.order_id === "string" ? data.order_id : null,
      merchantRef: typeof data.merchant_order_reference === "string" ? data.merchant_order_reference : null,
      status: typeof data.status === "string" ? data.status : null,
    };
  } catch {
    return null;
  }
}
