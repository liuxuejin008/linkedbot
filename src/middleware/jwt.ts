import { Context, Next } from "hono";
import { verifyJwt } from "../lib/crypto";
import type { AppEnv } from "../types";

export async function jwtAuth(c: Context<AppEnv>, next: Next) {
  const auth = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return c.json({ error: "missing_bearer_token" }, 401);
  }
  const token = auth.slice(7).trim();
  if (!token) {
    return c.json({ error: "missing_bearer_token" }, 401);
  }
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "invalid_token" }, 401);
  }
  const userId = Number(payload.sub);
  if (!userId) {
    return c.json({ error: "invalid_token" }, 401);
  }
  c.set("userId", userId);
  await next();
}
