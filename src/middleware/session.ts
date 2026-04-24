import { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";

const COOKIE_NAME = "linkedbot_session";
const MAX_AGE = 14 * 24 * 3600;

async function sign(value: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${value}.${sigB64}`;
}

async function unsign(
  signed: string,
  secret: string
): Promise<string | null> {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const expected = await sign(value, secret);
  if (expected !== signed) return null;
  return value;
}

export function getSessionUserId(c: Context<AppEnv>): number | null {
  return (c.get("sessionUserId") as number | null) ?? null;
}

export async function sessionMiddleware(c: Context<AppEnv>, next: Next) {
  const raw = getCookie(c, COOKIE_NAME);
  if (raw) {
    const value = await unsign(raw, c.env.SECRET_KEY);
    if (value) {
      const uid = parseInt(value, 10);
      if (!isNaN(uid)) c.set("sessionUserId", uid);
    }
  }
  await next();
}

export async function setSession(c: Context<AppEnv>, userId: number) {
  const signed = await sign(String(userId), c.env.SECRET_KEY);
  setCookie(c, COOKIE_NAME, signed, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: MAX_AGE,
  });
}

export function clearSession(c: Context<AppEnv>) {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export function loginRequired(c: Context<AppEnv>): Response | null {
  const uid = getSessionUserId(c);
  if (!uid) {
    return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
  }
  return null;
}
