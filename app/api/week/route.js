import { db } from "../../../lib/db";
import { currentUser } from "../../../lib/auth";
import { forecast, airQuality } from "../../../lib/weather";
import { todayIn, addDays, weekday, mondayOf } from "../../../lib/time";
import { json, serverError } from "../../../lib/http";

// one monday-sunday week. ?week=0 is this week, ?week=1 is next week
export async function GET(req) {
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: "Please log in." }, 401);
    const sql = db();
    const today = todayIn(user.tz);
    const week = Math.min(Math.max(Number(new URL(req.url).searchParams.get("week")) || 0, 0), 1);
    const start = addDays(mondayOf(today), week * 7);
    const end = addDays(start, 6);
    const [events, tasks, logs, fc, air] = await Promise.all([
      sql`select id, task_id, title, date, start_min, end_min, kind, category, note from events
          where user_id = ${user.id} and date between ${start} and ${end} order by date, start_min`,
      sql`select t.id, t.title, t.category, t.duration_min, t.outdoor,
          exists(select 1 from events e where e.task_id = t.id) as scheduled
          from tasks t where t.user_id = ${user.id} order by t.id`,
      sql`select id, ts, tool, args, status, result, (undo is not null) as can_undo
          from logs where user_id = ${user.id} order by id desc limit 60`,
      forecast(user.lat, user.lon, user.tz).catch(() => []),
      airQuality(user.lat, user.lon, user.tz).catch(() => ({})),
    ]);
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      const w = fc.find((d) => d.date === date);
      return { date, label: weekday(date, "short"), past: date < today, weather: w ? { ...w, aqi: air[date] ?? null } : null };
    });
    return json({ user: { email: user.email, city: user.city }, today, week, start, end, days, events, tasks, logs });
  } catch (err) {
    return serverError(err);
  }
}
