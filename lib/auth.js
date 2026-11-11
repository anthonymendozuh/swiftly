import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
import { db, ensureSchema } from "./db";

export const COOKIE = "swiftly_session";
const TWO_WEEKS = 60 * 60 * 24 * 14;

// falls back to a secret derived from the db url so one less env var is needed
function secret() {
  return process.env.SESSION_SECRET || createHash("sha256").update("swiftly:" + (process.env.DATABASE_URL || process.env.POSTGRES_URL || "dev")).digest("hex");
}

export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 32).toString("hex")}`;
}

export function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

const sign = (v) => createHmac("sha256", secret()).update(v).digest("base64url");

export function makeSession(userId) {
  const v = `${userId}.${Date.now() + TWO_WEEKS * 1000}`;
  return `${v}.${sign(v)}`;
}

export function readSession(token) {
  const [id, exp, sig] = String(token || "").split(".");
  if (!id || !exp || !sig) return null;
  const good = sign(`${id}.${exp}`);
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (+exp < Date.now()) return null;
  return +id;
}

export function sessionCookie(token, maxAge = TWO_WEEKS) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function currentUser(req) {
  const id = readSession(req.cookies.get(COOKIE)?.value);
  if (!id) return null;
  await ensureSchema();
  const rows = await db()`select id, email, city, lat, lon, tz from users where id = ${id}`;
  return rows[0] || null;
}
