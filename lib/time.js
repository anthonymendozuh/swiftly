// dates are 'yyyy-mm-dd' in the user's timezone, times are minutes after midnight

export function todayIn(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function nowMinIn(tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  return +p.find((x) => x.type === "hour").value * 60 + +p.find((x) => x.type === "minute").value;
}

export function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(date, style = "long") {
  return new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { weekday: style, timeZone: "UTC" });
}

export function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m || +m[1] > 24 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

export function toHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// weeks run monday-sunday. the agent can plan from today through the end of next week
export function mondayOf(date) {
  const dow = (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

export const windowEnd = (today) => addDays(mondayOf(today), 13);

export function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
}
