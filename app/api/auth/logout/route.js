import { sessionCookie } from "../../../../lib/auth";
import { json } from "../../../../lib/http";

export async function POST() {
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}
