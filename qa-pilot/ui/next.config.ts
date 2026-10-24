import type { NextConfig } from "next";

/**
 * Where the qa-pilot API really lives, when the UI is served from somewhere else (a Vercel
 * deployment in front of an API on another host). The UI then calls its own `/api` and this
 * rewrite forwards it, so the browser only ever talks to one origin: the session cookie is
 * first-party, the middleware can see it, and no CORS is involved. Build with
 * NEXT_PUBLIC_QA_PILOT_API=/api alongside it. Unset in local development, where the UI
 * calls the API on :4000 directly.
 */
const upstream = process.env.QA_PILOT_API_UPSTREAM?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return upstream ? [{ source: "/api/:path*", destination: `${upstream}/:path*` }] : [];
  },
};

export default nextConfig;
