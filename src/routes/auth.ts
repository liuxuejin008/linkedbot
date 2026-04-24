import { Hono } from "hono";
import { hashPassword, verifyPassword, createAccessToken } from "../lib/crypto";
import type { AppEnv, UserRow } from "../types";

const auth = new Hono<AppEnv>();

auth.post("/register", async (c) => {
  try {
    const body = await c.req.json<{ email?: string; password?: string }>();
    const email = body.email?.trim().toLowerCase();
    const password = body.password;

    if (!email || !email.includes("@")) {
      return c.json({ error: "invalid_email" }, 400);
    }
    if (!password || password.length < 8) {
      return c.json({ error: "password_too_short", min: 8 }, 400);
    }

    const existing = await c.env.DB.prepare(
      "SELECT id FROM users WHERE email = ?"
    )
      .bind(email)
      .first<UserRow>();
    if (existing) {
      return c.json({ error: "email_taken" }, 409);
    }

    const hash = await hashPassword(password);
    const result = await c.env.DB.prepare(
      "INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id"
    )
      .bind(email, hash)
      .first<{ id: number }>();

    const userId = result!.id;
    const hours = parseInt(c.env.JWT_EXPIRES_HOURS) || 24;
    const token = await createAccessToken(userId, c.env.JWT_SECRET, hours);

    return c.json({ user_id: userId, email, access_token: token }, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[register]", msg);
    return c.json({ error: "register_failed", detail: msg }, 500);
  }
});

auth.post("/login", async (c) => {
  try {
    const body = await c.req.json<{ email?: string; password?: string }>();
    const email = body.email?.trim().toLowerCase();
    const password = body.password;

    if (!email || !password) {
      return c.json({ error: "invalid_credentials" }, 401);
    }

    const user = await c.env.DB.prepare(
      "SELECT id, email, password_hash FROM users WHERE email = ?"
    )
      .bind(email)
      .first<UserRow>();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return c.json({ error: "invalid_credentials" }, 401);
    }

    const hours = parseInt(c.env.JWT_EXPIRES_HOURS) || 24;
    const token = await createAccessToken(user.id, c.env.JWT_SECRET, hours);

    return c.json({ user_id: user.id, email: user.email, access_token: token });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[login]", msg);
    return c.json({ error: "login_failed", detail: msg }, 500);
  }
});

export default auth;
