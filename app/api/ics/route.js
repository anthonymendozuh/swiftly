import { db } from "../../../lib/db";
import { currentUser } from "../../../lib/auth";
import { todayIn } from "../../../lib/time";

// calendar export (floating local times, imports into google / apple calendar)
const stamp = (date, min) => `${date.replaceAll("-", "")}T${String(Math.floor(min / 60)).padStart(2, "0")}${String(min % 60).padStart(2, "0")}00`;
const esc = (s) => String(s).replace(/[\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");

export async function GET(req) {
  const user = await currentUser(req);
  if (!user) return new Response("Please log in.", { status: 401 });
  const rows = await db()`select * from events where user_id = ${user.id} and date >= ${todayIn(user.tz)} order by date, start_min`;
  const now = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Swiftly//Planner//EN", "CALSCALE:GREGORIAN"];
  for (const e of rows) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:swiftly-${e.id}@swiftly`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(e.date, e.start_min)}`,
      `DTEND:${stamp(e.date, Math.min(e.end_min, 23 * 60 + 59))}`,
      `SUMMARY:${esc(e.title)}`,
      `CATEGORIES:${e.kind === "fixed" ? "Commitment" : e.category}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.join("\r\n"), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="swiftly-week.ics"' },
  });
}
