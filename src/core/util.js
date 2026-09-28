// Shared helpers (X09 core — identical in every X09 repo)

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export const now = () => Date.now();
export const month = () => new Date().toISOString().slice(0, 7);

const enc = new TextEncoder();

export function randomId(bytes = 16) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// Constant-time string comparison
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Sessions are shared by every X09 site: on *.x09hub.com the cookie is scoped to the parent
// domain, so signing in on x09hub.com also signs you in on ai.x09hub.com and docs.x09hub.com.
export const SHARED_DOMAIN = "x09hub.com";
export function cookieDomain(request) {
  const host = new URL(request.url).hostname;
  return host === SHARED_DOMAIN || host.endsWith("." + SHARED_DOMAIN) ? SHARED_DOMAIN : null;
}
