import { db, ensureSchema } from "../../../../lib/db";
import { hashPassword, makeSession, sessionCookie } from "../../../../lib/auth";
import { geocode } from "../../../../lib/weather";
import { json, serverError, throttle } from "../../../../lib/http";

export async function POST(req) {
  try {
    const { email, password, city } = await req.json().catch(() => ({}));
    const e = String(email || "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(e)) return json({ error: "Enter a valid email." }, 400);
    if (String(password || "").length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    if (!String(city || "").trim()) return json({ error: "Enter your city so Swiftly can check the weather." }, 400);
    if (!throttle("signup:" + (req.headers.get("x-forwarded-for") || "local"), 5)) return json({ error: "Too many attempts, wait a minute." }, 429);

    const place = await geocode(String(city).trim());
    if (!place) return json({ error: `Couldn't find "${city}". Try just the city name.` }, 400);

    await ensureSchema();
    const sql = db();
    const [exists] = await sql`select id from users where email = ${e}`;
    if (exists) return json({ error: "That email already has an account. Log in instead." }, 409);
    const [user] = await sql`
      insert into users (email, pass_hash, city, lat, lon, tz)
      values (${e}, ${hashPassword(password)}, ${place.city}, ${place.lat}, ${place.lon}, ${place.tz}) returning id`;
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(makeSession(user.id)) });
  } catch (err) {
    return serverError(err);
  }
}
