import { addDays, nowMinIn, toMin, toHHMM, weekday, windowEnd, daysBetween } from "./time";
import { aqiLevel } from "./weather";

const CATS = ["physical", "mental", "errand", "other"];
const COMMIT_TYPES = ["work", "class", "social", "appointment", "other"];

// ---------- validation ----------
// arg specs: "string" | "int" | "bool" | "date" | "time" | list of allowed values. trailing "?" = optional

function coerce(spec, v) {
  if (Array.isArray(spec)) return spec.includes(v) ? v : undefined;
  switch (spec) {
    case "string":
      return typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined;
    case "int": {
      const n = Number(v);
      return Number.isInteger(n) ? n : undefined;
    }
    case "bool":
      return v === true || v === "true" ? true : v === false || v === "false" ? false : undefined;
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
    case "time": {
      const m = toMin(v);
      return m === null ? undefined : m;
    }
  }
}

export function validateCall(call) {
  if (!call || typeof call !== "object") return { error: "each action must be an object" };
  const tool = TOOLS[call.tool];
  if (!tool) return { error: `unknown tool "${call.tool}"` };
  const args = {};
  for (const [k, raw] of Object.entries(tool.args)) {
    const optional = typeof raw === "string" && raw.endsWith("?");
    const spec = optional ? raw.slice(0, -1) : raw;
    const given = call.args?.[k];
    if (optional && (given === undefined || given === null || given === "")) continue;
    const v = coerce(spec, given);
    if (v === undefined) {
      return { error: `${call.tool}: bad or missing "${k}" (expected ${Array.isArray(spec) ? spec.join("|") : spec})` };
    }
    args[k] = v;
  }
  return { name: call.tool, tool, args };
}

// ---------- safety checks ----------

const lastDay = (ctx) => windowEnd(ctx.today);
const windowLen = (ctx) => daysBetween(ctx.today, lastDay(ctx)) + 1;
const label = (date, s, e) => `${weekday(date, "short")} ${date} ${toHHMM(s)}–${toHHMM(e)}`;
const EVENT_COLS = ["task_id", "title", "date", "start_min", "end_min", "kind", "category", "note"];
export const snapshot = (e) => Object.fromEntries(EVENT_COLS.map((k) => [k, e[k] ?? null]));

function slotProblem(ctx, date, start, end, { allowPast = false } = {}) {
  if (date < ctx.today || date > lastDay(ctx)) return `${date} is outside the planning window (${ctx.today} to ${lastDay(ctx)})`;
  if (!allowPast && date === ctx.today && start < nowMinIn(ctx.user.tz)) return `${toHHMM(start)} has already passed today`;
  if (end <= start) return "end must be after start";
  if (start < 5 * 60 || end > 24 * 60) return "times must be between 05:00 and 24:00";
  return null;
}

async function conflict(ctx, date, start, end, ignoreId = 0) {
  const rows = await ctx.sql`
    select id, title, start_min, end_min, kind from events
    where user_id = ${ctx.user.id} and date = ${date} and id <> ${ignoreId}
      and start_min < ${end} and end_min > ${start}
    limit 1`;
  return rows[0] || null;
}

// outdoor problems for a slot: rain, heat, uv, air quality, darkness
async function outdoorProblems(ctx, date, start, end) {
  const day = (await ctx.forecast())?.find((d) => d.date === date);
  const aqi = (await ctx.air())?.[date];
  const p = [];
  if (day) {
    if (day.rain_chance >= 50) p.push(`${day.rain_chance}% chance of rain`);
    if (day.high >= 90 && start < 17 * 60 && end > 11 * 60) p.push(`${day.high}°F midday heat`);
    if (day.uv >= 8 && start < 16 * 60 && end > 10 * 60) p.push(`UV ${day.uv} at midday`);
    const sr = toMin(day.sunrise);
    const ss = toMin(day.sunset);
    if (sr !== null && start < sr) p.push(`starts before sunrise (${day.sunrise})`);
    if (ss !== null && end > ss) p.push(`runs past sunset (${day.sunset})`);
  }
  if (aqi > 100) p.push(`AQI ${aqi}, ${aqiLevel(aqi)}`);
  return p;
}

async function weatherWarning(ctx, date, start, end, outdoor) {
  if (!outdoor) return "";
  const p = await outdoorProblems(ctx, date, start, end);
  return p.length ? ` WARNING: ${p.join(", ")}. consider another slot.` : "";
}

async function ownedEvent(ctx, id) {
  const [e] = await ctx.sql`select * from events where id = ${id} and user_id = ${ctx.user.id}`;
  if (!e) throw new Error(`event ${id} not found`);
  return e;
}

async function ownedTask(ctx, id) {
  const [t] = await ctx.sql`select * from tasks where id = ${id} and user_id = ${ctx.user.id}`;
  if (!t) throw new Error(`task ${id} not found`);
  return t;
}

const fmtEvent = (e) => ({
  id: e.id,
  task_id: e.task_id ?? undefined,
  title: e.title,
  date: e.date,
  day: weekday(e.date, "short"),
  start: toHHMM(e.start_min),
  end: toHHMM(e.end_min),
  category: e.kind === "fixed" ? undefined : e.category,
  type: e.kind === "fixed" ? e.category : undefined,
  note: e.note ?? undefined,
});

async function placeTask(ctx, t, date, start) {
  const [dupe] = await ctx.sql`select id from events where task_id = ${t.id} limit 1`;
  if (dupe) throw new Error(`task ${t.id} is already scheduled as event ${dupe.id}; use move_block`);
  const end = start + t.duration_min;
  const bad = slotProblem(ctx, date, start, end);
  if (bad) throw new Error(bad);
  const c = await conflict(ctx, date, start, end);
  if (c) throw new Error(`conflicts with ${c.kind === "fixed" ? "commitment" : "block"} ${c.id} "${c.title}" ${toHHMM(c.start_min)}–${toHHMM(c.end_min)}`);
  const [row] = await ctx.sql`
    insert into events (user_id, task_id, title, date, start_min, end_min, kind, category)
    values (${ctx.user.id}, ${t.id}, ${t.title}, ${date}, ${start}, ${end}, 'plan', ${t.category}) returning id`;
  const warn = await weatherWarning(ctx, date, start, end, t.outdoor);
  return { id: row.id, text: `event ${row.id}, ${label(date, start, end)}.${warn}` };
}

// ---------- tools ----------
// a tool sets ctx.undo to record how to reverse what it did.
// destructive tools are never run by the agent directly: they become a pending action the user confirms.

export const TOOLS = {
  get_forecast: {
    desc: "7-day weather for the user's city: summary, high/low °F, rain_chance %, wind, uv index, sunrise/sunset.",
    args: {},
    async run(ctx) {
      const fc = await ctx.forecast();
      if (!fc) throw new Error("weather service unavailable right now");
      return fc.filter((d) => d.date >= ctx.today && d.date <= lastDay(ctx)).map(({ code, ...d }) => ({ ...d, day: weekday(d.date, "short") }));
    },
  },

  get_air_quality: {
    desc: "daily max US AQI (air quality, smoke/pollution) and UV index for the planning window.",
    args: {},
    async run(ctx) {
      const air = await ctx.air();
      const fc = (await ctx.forecast()) || [];
      if (!air && !fc.length) throw new Error("air quality service unavailable right now");
      return Array.from({ length: windowLen(ctx) }, (_, i) => {
        const date = addDays(ctx.today, i);
        const aqi = air?.[date] ?? null;
        return { date, day: weekday(date, "short"), aqi, level: aqiLevel(aqi), uv: fc.find((d) => d.date === date)?.uv ?? null };
      });
    },
  },

  get_week: {
    desc: "the user's commitments, planned blocks and unscheduled tasks for the planning window. ids come from here.",
    args: {},
    async run(ctx) {
      const ev = await ctx.sql`
        select * from events where user_id = ${ctx.user.id} and date between ${ctx.today} and ${lastDay(ctx)}
        order by date, start_min`;
      const tasks = await ctx.sql`
        select t.*, (select count(*) from events e where e.task_id = t.id)::int as blocks
        from tasks t where t.user_id = ${ctx.user.id} order by t.id`;
      return {
        commitments: ev.filter((e) => e.kind === "fixed").map(fmtEvent),
        planned: ev.filter((e) => e.kind === "plan").map(fmtEvent),
        unscheduled_tasks: tasks
          .filter((t) => !t.blocks)
          .map((t) => ({ id: t.id, title: t.title, category: t.category, duration_min: t.duration_min, outdoor: t.outdoor })),
      };
    },
  },

  check_conflicts: {
    desc: "re-check every planned outdoor block against the LATEST forecast and air quality. returns the blocks that now have problems.",
    args: {},
    async run(ctx) {
      const rows = await ctx.sql`
        select e.* from events e join tasks t on t.id = e.task_id
        where e.user_id = ${ctx.user.id} and e.kind = 'plan' and t.outdoor = true
          and e.date between ${ctx.today} and ${lastDay(ctx)}
        order by e.date, e.start_min`;
      const flagged = [];
      for (const e of rows) {
        const problems = await outdoorProblems(ctx, e.date, e.start_min, e.end_min);
        if (problems.length) flagged.push({ ...fmtEvent(e), problems });
      }
      return { outdoor_blocks_checked: rows.length, flagged };
    },
  },

  find_trails: {
    desc: "real named hiking trails near the user's city (OpenStreetMap). use when scheduling a hike.",
    args: { radius_miles: "int?" },
    async run(ctx, a) {
      const radius = Math.min(Math.max(a.radius_miles ?? 20, 3), 40);
      const trails = await ctx.trails(radius);
      if (!trails.length) return `no named trails found within ${radius} miles`;
      return trails;
    },
  },

  add_commitment: {
    desc: "save one fixed commitment from the user's schedule. type: work (shifts/jobs), class (school), social (dates, friends, family, events), appointment (doctor, dentist, meetings), other. one call per occurrence.",
    args: { title: "string", date: "date", start: "time", end: "time", type: "string?" },
    async run(ctx, a) {
      const bad = slotProblem(ctx, a.date, a.start, a.end, { allowPast: true });
      if (bad) throw new Error(bad);
      const [row] = await ctx.sql`
        insert into events (user_id, title, date, start_min, end_min, kind, category)
        values (${ctx.user.id}, ${a.title}, ${a.date}, ${a.start}, ${a.end}, 'fixed', ${COMMIT_TYPES.includes(a.type) ? a.type : "other"}) returning id`;
      ctx.undo = { op: "delete_event", id: row.id };
      const c = await conflict(ctx, a.date, a.start, a.end, row.id);
      const note = c?.kind === "plan" ? ` NOTE: overlaps planned block ${c.id} "${c.title}", move it.` : "";
      return `saved commitment ${row.id} "${a.title}" ${label(a.date, a.start, a.end)}.${note}`;
    },
  },

  add_task: {
    desc: "save one to-do. repeated activities (run x3) = one task per occurrence. pass date + start to also put it on the calendar in the same call.",
    args: { title: "string", category: CATS, duration_min: "int", outdoor: "bool", date: "date?", start: "time?" },
    async run(ctx, a) {
      if (a.duration_min < 10 || a.duration_min > 600) throw new Error("duration_min must be 10–600");
      const [row] = await ctx.sql`
        insert into tasks (user_id, title, category, duration_min, outdoor)
        values (${ctx.user.id}, ${a.title}, ${a.category}, ${a.duration_min}, ${a.outdoor}) returning *`;
      ctx.undo = { op: "delete_task", id: row.id };
      const out = { task_id: row.id, title: a.title };
      if (a.date && a.start !== undefined) {
        try {
          out.scheduled = (await placeTask(ctx, row, a.date, a.start)).text;
        } catch (e) {
          out.not_scheduled = `${e.message}. task is saved; use schedule_task(${row.id}, ...) with another slot`;
        }
      }
      return out;
    },
  },

  schedule_task: {
    desc: "put a saved task on the calendar. end time = start + the task's duration.",
    args: { task_id: "int", date: "date", start: "time" },
    async run(ctx, a) {
      const t = await ownedTask(ctx, a.task_id);
      const placed = await placeTask(ctx, t, a.date, a.start);
      ctx.undo = { op: "delete_event", id: placed.id };
      return `scheduled "${t.title}" as ${placed.text}`;
    },
  },

  move_block: {
    desc: "move a planned block to a new date/start. commitments can't be moved.",
    args: { event_id: "int", date: "date", start: "time" },
    async run(ctx, a) {
      const e = await ownedEvent(ctx, a.event_id);
      if (e.kind === "fixed") throw new Error("commitments can't be moved by the agent");
      const end = a.start + (e.end_min - e.start_min);
      const bad = slotProblem(ctx, a.date, a.start, end);
      if (bad) throw new Error(bad);
      const c = await conflict(ctx, a.date, a.start, end, e.id);
      if (c) throw new Error(`conflicts with ${c.kind === "fixed" ? "commitment" : "block"} ${c.id} "${c.title}" ${toHHMM(c.start_min)}–${toHHMM(c.end_min)}`);
      await ctx.sql`update events set date = ${a.date}, start_min = ${a.start}, end_min = ${end} where id = ${e.id}`;
      ctx.undo = { op: "update_event", id: e.id, date: e.date, start_min: e.start_min, end_min: e.end_min };
      const [t] = e.task_id ? await ctx.sql`select outdoor from tasks where id = ${e.task_id}` : [];
      const warn = await weatherWarning(ctx, a.date, a.start, end, t?.outdoor);
      return `moved "${e.title}" from ${label(e.date, e.start_min, e.end_min)} to ${label(a.date, a.start, end)}.${warn}`;
    },
  },

  set_note: {
    desc: "attach a short note to a planned block, e.g. the trail for a hike: \"Marshall Canyon Trail · 6.2 mi away\".",
    args: { event_id: "int", note: "string" },
    async run(ctx, a) {
      const e = await ownedEvent(ctx, a.event_id);
      if (e.kind === "fixed") throw new Error("notes can only go on planned blocks");
      await ctx.sql`update events set note = ${a.note} where id = ${e.id}`;
      ctx.undo = { op: "set_note", id: e.id, note: e.note ?? null };
      return `added note to "${e.title}": ${a.note}`;
    },
  },

  delete_event: {
    desc: "DESTRUCTIVE (needs user confirmation): remove one event or commitment.",
    destructive: true,
    args: { event_id: "int" },
    async preview(ctx, a) {
      const e = await ownedEvent(ctx, a.event_id);
      return `Delete ${e.kind === "fixed" ? "commitment" : "block"} "${e.title}" on ${label(e.date, e.start_min, e.end_min)}`;
    },
    async run(ctx, a) {
      const e = await ownedEvent(ctx, a.event_id);
      await ctx.sql`delete from events where id = ${e.id}`;
      ctx.undo = { op: "insert_events", rows: [snapshot(e)] };
      return `deleted "${e.title}" (${label(e.date, e.start_min, e.end_min)})`;
    },
  },

  clear_day: {
    desc: "DESTRUCTIVE (needs user confirmation): remove every planned block on a date. commitments stay; tasks go back to unscheduled.",
    destructive: true,
    args: { date: "date" },
    async preview(ctx, a) {
      const rows = await ctx.sql`select title from events where user_id = ${ctx.user.id} and date = ${a.date} and kind = 'plan'`;
      if (!rows.length) throw new Error(`nothing planned on ${a.date}`);
      return `Clear ${weekday(a.date)} ${a.date}: remove ${rows.length} planned block${rows.length > 1 ? "s" : ""} (${rows.map((r) => r.title).join(", ")})`;
    },
    async run(ctx, a) {
      const rows = await ctx.sql`delete from events where user_id = ${ctx.user.id} and date = ${a.date} and kind = 'plan' returning *`;
      ctx.undo = { op: "insert_events", rows: rows.map(snapshot) };
      return `cleared ${rows.length} block(s) on ${a.date}`;
    },
  },

  delete_task: {
    desc: "DESTRUCTIVE (needs user confirmation): remove a task and its calendar block.",
    destructive: true,
    args: { task_id: "int" },
    async preview(ctx, a) {
      const t = await ownedTask(ctx, a.task_id);
      return `Delete task "${t.title}" and anything scheduled for it`;
    },
    async run(ctx, a) {
      const t = await ownedTask(ctx, a.task_id);
      const ev = await ctx.sql`delete from events where task_id = ${t.id} returning *`;
      await ctx.sql`delete from tasks where id = ${t.id}`;
      ctx.undo = {
        op: "insert_task",
        task: { title: t.title, category: t.category, duration_min: t.duration_min, outdoor: t.outdoor },
        events: ev.map(snapshot),
      };
      return `deleted task "${t.title}"`;
    },
  },
};

export function toolCatalog() {
  return Object.entries(TOOLS)
    .map(([name, t]) => {
      const args = Object.entries(t.args)
        .map(([k, s]) => (typeof s === "string" && s.endsWith("?") ? `${k}?: ${s.slice(0, -1)}` : `${k}: ${Array.isArray(s) ? s.join("|") : s}`))
        .join(", ");
      return `- ${name}(${args}) — ${t.desc}`;
    })
    .join("\n");
}

// short text for the ui
export function summarize(name, out) {
  if (typeof out === "string") return out;
  if (name === "get_forecast") return out.map((d) => `${d.day} ${d.high}° ${d.rain_chance}%`).join(" · ");
  if (name === "get_air_quality") return out.map((d) => `${d.day} AQI ${d.aqi ?? "?"} UV ${d.uv ?? "?"}`).join(" · ");
  if (name === "get_week") return `${out.commitments.length} commitments, ${out.planned.length} planned, ${out.unscheduled_tasks.length} unscheduled`;
  if (name === "check_conflicts") return out.flagged.length ? `${out.flagged.length} of ${out.outdoor_blocks_checked} outdoor blocks need moving: ${out.flagged.map((f) => `${f.title} (${f.problems[0]})`).join("; ")}` : `all ${out.outdoor_blocks_checked} outdoor blocks look good`;
  if (name === "find_trails") return out.slice(0, 3).map((t) => `${t.name} (${t.miles_away} mi)`).join(", ") + (out.length > 3 ? ` +${out.length - 3} more` : "");
  if (name === "add_task") return `saved task ${out.task_id} "${out.title}"${out.scheduled ? ` → ${out.scheduled}` : out.not_scheduled ? ` (not placed: ${out.not_scheduled.split(".")[0]})` : ""}`;
  return JSON.stringify(out).slice(0, 160);
}

// ---------- undo ----------

async function insertEvent(ctx, e) {
  let taskId = e.task_id ?? null;
  if (taskId) {
    const [t] = await ctx.sql`select id from tasks where id = ${taskId} and user_id = ${ctx.user.id}`;
    if (!t) taskId = null;
  }
  await ctx.sql`
    insert into events (user_id, task_id, title, date, start_min, end_min, kind, category, note)
    values (${ctx.user.id}, ${taskId}, ${e.title}, ${e.date}, ${e.start_min}, ${e.end_min}, ${e.kind}, ${e.category}, ${e.note ?? null})`;
}

export async function applyUndo(ctx, u) {
  const uid = ctx.user.id;
  switch (u?.op) {
    case "delete_event": {
      const r = await ctx.sql`delete from events where id = ${u.id} and user_id = ${uid} returning title`;
      if (!r.length) throw new Error("that event is already gone");
      return `removed "${r[0].title}"`;
    }
    case "delete_task": {
      await ctx.sql`delete from events where task_id = ${u.id} and user_id = ${uid}`;
      const r = await ctx.sql`delete from tasks where id = ${u.id} and user_id = ${uid} returning title`;
      if (!r.length) throw new Error("that task is already gone");
      return `removed task "${r[0].title}"`;
    }
    case "update_event": {
      const r = await ctx.sql`
        update events set date = ${u.date}, start_min = ${u.start_min}, end_min = ${u.end_min}
        where id = ${u.id} and user_id = ${uid} returning title`;
      if (!r.length) throw new Error("that event no longer exists");
      return `moved "${r[0].title}" back to ${label(u.date, u.start_min, u.end_min)}`;
    }
    case "set_note": {
      const r = await ctx.sql`update events set note = ${u.note} where id = ${u.id} and user_id = ${uid} returning title`;
      if (!r.length) throw new Error("that event no longer exists");
      return `restored the note on "${r[0].title}"`;
    }
    case "insert_events": {
      for (const e of u.rows) await insertEvent(ctx, e);
      return `restored ${u.rows.length} event(s): ${u.rows.map((e) => e.title).join(", ")}`;
    }
    case "insert_task": {
      const t = u.task;
      const [row] = await ctx.sql`
        insert into tasks (user_id, title, category, duration_min, outdoor)
        values (${uid}, ${t.title}, ${t.category}, ${t.duration_min}, ${t.outdoor}) returning id`;
      for (const e of u.events) await insertEvent(ctx, { ...e, task_id: row.id });
      return `restored task "${t.title}"`;
    }
    case "restore_all": {
      const ids = {};
      for (const t of u.tasks) {
        const [row] = await ctx.sql`
          insert into tasks (user_id, title, category, duration_min, outdoor)
          values (${uid}, ${t.title}, ${t.category}, ${t.duration_min}, ${t.outdoor}) returning id`;
        ids[t.id] = row.id;
      }
      for (const e of u.events) await insertEvent(ctx, { ...e, task_id: e.task_id ? ids[e.task_id] ?? null : null });
      return `restored ${u.events.length} event(s) and ${u.tasks.length} task(s)`;
    }
    default:
      throw new Error("this action can't be undone");
  }
}

// ---------- executor ----------

export async function log(ctx, tool, args, status, result, undo = null) {
  try {
    await ctx.sql`
      insert into logs (user_id, tool, args, status, result, undo)
      values (${ctx.user.id}, ${tool}, ${JSON.stringify(args ?? {})}::jsonb, ${status}, ${String(result).slice(0, 1000)},
              ${undo ? JSON.stringify(undo) : null}::jsonb)`;
  } catch {}
}

export async function execute(ctx, call) {
  const v = validateCall(call);
  if (v.error) {
    await log(ctx, String(call?.tool ?? "?"), call?.args, "blocked", v.error);
    return { tool: call?.tool, args: call?.args, status: "blocked", result: v.error, summary: v.error };
  }
  try {
    if (v.tool.destructive) {
      const description = await v.tool.preview(ctx, v.args);
      const [row] = await ctx.sql`
        insert into logs (user_id, tool, args, status, result)
        values (${ctx.user.id}, ${v.name}, ${JSON.stringify(call.args ?? {})}::jsonb, 'pending', ${description}) returning id`;
      return { tool: v.name, args: call.args, status: "pending", result: `awaiting user confirmation: ${description}`, summary: description, pending_id: row.id };
    }
    ctx.undo = null;
    const out = await v.tool.run(ctx, v.args);
    const summary = summarize(v.name, out);
    await log(ctx, v.name, call.args, "ok", summary, ctx.undo);
    return { tool: v.name, args: call.args, status: "ok", result: out, summary };
  } catch (e) {
    await log(ctx, v.name, call.args, "error", e.message);
    return { tool: v.name, args: call.args, status: "error", result: e.message, summary: e.message };
  }
}
