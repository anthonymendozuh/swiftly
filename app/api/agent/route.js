import { db } from "../../../lib/db";
import { currentUser } from "../../../lib/auth";
import { runAgent, CONTINUE_MSG } from "../../../lib/agent";
import { json, serverError, throttle } from "../../../lib/http";

export const maxDuration = 60;

export async function POST(req) {
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: "Please log in." }, 401);
    if (!throttle("agent:" + user.id, 20)) return json({ error: "Slow down a little, try again in a minute." }, 429);

    const body = await req.json().catch(() => ({}));
    const { history } = body;
    const text = body.continue ? CONTINUE_MSG : String(body.message || "").trim().slice(0, 2000);
    if (!text) return json({ error: "Type a request first." }, 400);

    const sql = db();
    await sql`insert into logs (user_id, tool, args, status, result) values (${user.id}, 'request', ${JSON.stringify({ message: text })}::jsonb, 'info', ${text.slice(0, 300)})`;
    const result = await runAgent({ sql, user, message: text, history });
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
