import { db } from "../../../lib/db";
import { currentUser } from "../../../lib/auth";
import { validateCall } from "../../../lib/tools";
import { makeContext } from "../../../lib/agent";
import { json, serverError } from "../../../lib/http";

// runs (or cancels) a destructive action the agent proposed
export async function POST(req) {
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: "Please log in." }, 401);
    const { id, confirm } = await req.json().catch(() => ({}));
    const sql = db();
    const [row] = await sql`
      select * from logs where id = ${Number(id) || 0} and user_id = ${user.id} and status = 'pending'
        and ts > now() - interval '15 minutes'`;
    if (!row) return json({ error: "That request expired or was already handled." }, 404);

    if (!confirm) {
      await sql`update logs set status = 'cancelled' where id = ${row.id}`;
      return json({ status: "cancelled", result: "Cancelled. Nothing was deleted." });
    }

    const args = typeof row.args === "string" ? JSON.parse(row.args) : row.args;
    const v = validateCall({ tool: row.tool, args });
    if (v.error || !v.tool.destructive) return json({ error: "Invalid pending action." }, 400);
    try {
      const out = await v.tool.run(makeContext(sql, user), v.args);
      await sql`update logs set status = 'confirmed', result = ${String(out)} where id = ${row.id}`;
      return json({ status: "confirmed", result: String(out) });
    } catch (e) {
      await sql`update logs set status = 'error', result = ${e.message} where id = ${row.id}`;
      return json({ error: e.message }, 400);
    }
  } catch (err) {
    return serverError(err);
  }
}
