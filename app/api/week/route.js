import { db } from "../../../lib/db";
import { currentUser } from "../../../lib/auth";
import { forecast } from "../../../lib/weather";
import { todayIn, addDays, weekday, WINDOW_DAYS } from "../../../lib/time";
import { json, serverError } from "../../../lib/http";

export async function GET(req) {
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: "Please log in." }, 401);
    const sql = db();
    const today = todayIn(user.tz);
    const last = addDays(today, WINDOW_DAYS - 1);
    const [events, tasks, logs, fc] = await Promise.all([
      sql`select id, task_id, title, date, start_min, end_min, kind, category from events
          where user_id = ${user.id} and date between ${today} and ${last} order by date, start_min`,
      sql`select t.id, t.title, t.category, t.duration_min, t.outdoor,
          exists(select 1 from events e where e.task_id = t.id) as scheduled
          from tasks t where t.user_id = ${user.id} order by t.id`,
      sql`select id, ts, tool, args, status, result from logs where user_id = ${user.id} order by id desc limit 60`,
      forecast(user.lat, user.lon, user.tz).catch(() => []),
    ]);
    const days = Array.from({ length: WINDOW_DAYS }, (_, i) => {
      const date = addDays(today, i);
      return { date, label: weekday(date, "short"), weather: fc.find((d) => d.date === date) || null };
    });
    return json({ user: { email: user.email, city: user.city }, today, days, events, tasks, logs });
  } catch (err) {
    return serverError(err);
  }
}
