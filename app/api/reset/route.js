import { db } from "../../../lib/db";
import { currentUser } from "../../../lib/auth";
import { log, snapshot } from "../../../lib/tools";
import { makeContext } from "../../../lib/agent";
import { json, serverError } from "../../../lib/http";

// wipes the user's calendar + tasks (asked for in the ui with a confirm popup). undoable from the log
export async function POST(req) {
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: "Please log in." }, 401);
    const sql = db();
    const events = await sql`delete from events where user_id = ${user.id} returning *`;
    const tasks = await sql`delete from tasks where user_id = ${user.id} returning *`;
    const undo = {
      op: "restore_all",
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, category: t.category, duration_min: t.duration_min, outdoor: t.outdoor })),
      events: events.map(snapshot),
    };
    const msg = `reset week: removed ${events.length} event(s) and ${tasks.length} task(s)`;
    await log(makeContext(sql, user), "reset_week", {}, "confirmed", msg, events.length || tasks.length ? undo : null);
    return json({ ok: true, result: msg });
  } catch (err) {
    return serverError(err);
  }
}
