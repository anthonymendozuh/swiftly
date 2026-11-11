import { db, ensureSchema } from "../../../../lib/db";
import { checkPassword, makeSession, sessionCookie } from "../../../../lib/auth";
import { json, serverError, throttle } from "../../../../lib/http";

export async function POST(req) {
  try {
    const { email, password } = await req.json().catch(() => ({}));
    const e = String(email || "").trim().toLowerCase();
    if (!throttle("login:" + e, 8)) return json({ error: "Too many attempts, wait a minute." }, 429);
    await ensureSchema();
    const [user] = await db()`select id, pass_hash from users where email = ${e}`;
    if (!user || !checkPassword(String(password || ""), user.pass_hash)) return json({ error: "Wrong email or password." }, 401);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(makeSession(user.id)) });
  } catch (err) {
    return serverError(err);
  }
}
