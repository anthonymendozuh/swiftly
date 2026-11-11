import { db } from "../../../lib/db";
import { currentUser } from "../../../lib/auth";
import { applyUndo, log } from "../../../lib/tools";
import { makeContext } from "../../../lib/agent";
import { json, serverError } from "../../../lib/http";

// reverses one logged action using the undo payload saved with it
export async function POST(req) {
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: "Please log in." }, 401);
    const { id } = await req.json().catch(() => ({}));
    const sql = db();
    const [row] = await sql`
      select * from logs where id = ${Number(id) || 0} and user_id = ${user.id}
        and status in ('ok', 'confirmed') and undo is not null`;
    if (!row) return json({ error: "That action can't be undone (or already was)." }, 404);
    const ctx = makeContext(sql, user);
    const undo = typeof row.undo === "string" ? JSON.parse(row.undo) : row.undo;
    try {
      const msg = await applyUndo(ctx, undo);
      await sql`update logs set status = 'undone' where id = ${row.id}`;
      await log(ctx, "undo", { log_id: row.id, of: row.tool }, "ok", msg);
      return json({ ok: true, result: msg });
    } catch (e) {
      await log(ctx, "undo", { log_id: row.id, of: row.tool }, "error", e.message);
      return json({ error: e.message }, 400);
    }
  } catch (err) {
    return serverError(err);
  }
}
