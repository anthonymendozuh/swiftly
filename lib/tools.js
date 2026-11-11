import { addDays, nowMinIn, toMin, toHHMM, weekday, WINDOW_DAYS } from "./time";

const CATS = ["physical", "mental", "errand", "other"];

// ---------- validation ----------
// arg specs: "string" | "int" | "bool" | "date" | "time" | list of allowed values

function coerce(spec, v) {
  if (Array.isArray(spec)) return spec.includes(v) ? v : undefined;
  switch (spec) {
    case "string":
      return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined;
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
  for (const [k, spec] of Object.entries(tool.args)) {
    const v = coerce(spec, call.args?.[k]);
    if (v === undefined) {
      return { error: `${call.tool}: bad or missing "${k}" (expected ${Array.isArray(spec) ? spec.join("|") : spec})` };
    }
    args[k] = v;
  }
  return { name: call.tool, tool, args };
}

// ---------- safety checks ----------

const lastDay = (ctx) => addDays(ctx.today, WINDOW_DAYS - 1);
const label = (date, s, e) => `${weekday(date, "short")} ${date} ${toHHMM(s)}–${toHHMM(e)}`;

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

async function weatherWarning(ctx, date, start, end, outdoor) {
  if (!outdoor) return "";
  const day = (await ctx.forecast())?.find((d) => d.date === date);
  if (!day) return "";
  const notes = [];
  if (day.rain_chance >= 50) notes.push(`${day.rain_chance}% chance of rain`);
  if (day.high >= 90 && start < 17 * 60 && end > 11 * 60) notes.push(`${day.high}°F midday heat`);
  const sr = toMin(day.sunrise);
  const ss = toMin(day.sunset);
  if (sr !== null && start < sr) notes.push(`starts before sunrise (${day.sunrise})`);
  if (ss !== null && end > ss) notes.push(`runs past sunset (${day.sunset})`);
  return notes.length ? ` WARNING: ${notes.join(", ")}. consider another slot.` : "";
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
});

// ---------- tools ----------
// destructive tools are never run by the agent directly: they become a pending action the user confirms

export const TOOLS = {
  get_forecast: {
    desc: "7-day weather for the user's city: summary, high/low °F, rain_chance %, wind, sunrise/sunset.",
    args: {},
    async run(ctx) {
      const fc = await ctx.forecast();
      if (!fc) throw new Error("weather service unavailable right now");
      return fc.slice(0, WINDOW_DAYS).map(({ code, ...d }) => ({ ...d, day: weekday(d.date, "short") }));
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

  add_commitment: {
    desc: "save one fixed commitment from the user's schedule (work shift, class, appointment). one call per occurrence.",
    args: { title: "string", date: "date", start: "time", end: "time" },
    async run(ctx, a) {
      const bad = slotProblem(ctx, a.date, a.start, a.end, { allowPast: true });
      if (bad) throw new Error(bad);
      const [row] = await ctx.sql`
        insert into events (user_id, title, date, start_min, end_min, kind, category)
        values (${ctx.user.id}, ${a.title}, ${a.date}, ${a.start}, ${a.end}, 'fixed', 'other') returning id`;
      const c = await conflict(ctx, a.date, a.start, a.end, row.id);
      const note = c?.kind === "plan" ? ` NOTE: overlaps planned block ${c.id} "${c.title}", move it.` : "";
      return `saved commitment ${row.id} "${a.title}" ${label(a.date, a.start, a.end)}.${note}`;
    },
  },

  add_task: {
    desc: "save one to-do that needs a time slot. repeated activities (run x3) = one task per occurrence.",
    args: { title: "string", category: CATS, duration_min: "int", outdoor: "bool" },
    async run(ctx, a) {
      if (a.duration_min < 10 || a.duration_min > 600) throw new Error("duration_min must be 10–600");
      const [row] = await ctx.sql`
        insert into tasks (user_id, title, category, duration_min, outdoor)
        values (${ctx.user.id}, ${a.title}, ${a.category}, ${a.duration_min}, ${a.outdoor}) returning id`;
      return { task_id: row.id, title: a.title };
    },
  },

  schedule_task: {
    desc: "put a saved task on the calendar. end time = start + the task's duration.",
    args: { task_id: "int", date: "date", start: "time" },
    async run(ctx, a) {
      const t = await ownedTask(ctx, a.task_id);
      const [dupe] = await ctx.sql`select id from events where task_id = ${t.id} limit 1`;
      if (dupe) throw new Error(`task ${t.id} is already scheduled as event ${dupe.id}; use move_block`);
      const end = a.start + t.duration_min;
      const bad = slotProblem(ctx, a.date, a.start, end);
      if (bad) throw new Error(bad);
      const c = await conflict(ctx, a.date, a.start, end);
      if (c) throw new Error(`conflicts with ${c.kind === "fixed" ? "commitment" : "block"} ${c.id} "${c.title}" ${toHHMM(c.start_min)}–${toHHMM(c.end_min)}`);
      const [row] = await ctx.sql`
        insert into events (user_id, task_id, title, date, start_min, end_min, kind, category)
        values (${ctx.user.id}, ${t.id}, ${t.title}, ${a.date}, ${a.start}, ${end}, 'plan', ${t.category}) returning id`;
      const warn = await weatherWarning(ctx, a.date, a.start, end, t.outdoor);
      return `scheduled "${t.title}" as event ${row.id}, ${label(a.date, a.start, end)}.${warn}`;
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
      const [t] = e.task_id ? await ctx.sql`select outdoor from tasks where id = ${e.task_id}` : [];
      const warn = await weatherWarning(ctx, a.date, a.start, end, t?.outdoor);
      return `moved "${e.title}" to ${label(a.date, a.start, end)}.${warn}`;
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
      const rows = await ctx.sql`delete from events where user_id = ${ctx.user.id} and date = ${a.date} and kind = 'plan' returning id`;
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
      await ctx.sql`delete from events where task_id = ${t.id}`;
      await ctx.sql`delete from tasks where id = ${t.id}`;
      return `deleted task "${t.title}"`;
    },
  },
};

export function toolCatalog() {
  return Object.entries(TOOLS)
    .map(([name, t]) => {
      const args = Object.entries(t.args).map(([k, s]) => `${k}: ${Array.isArray(s) ? s.join("|") : s}`).join(", ");
      return `- ${name}(${args}) — ${t.desc}`;
    })
    .join("\n");
}

// short text for the ui
export function summarize(name, out) {
  if (typeof out === "string") return out;
  if (name === "get_forecast") return out.map((d) => `${d.day} ${d.high}° ${d.rain_chance}%`).join(" · ");
  if (name === "get_week") return `${out.commitments.length} commitments, ${out.planned.length} planned, ${out.unscheduled_tasks.length} unscheduled`;
  if (name === "add_task") return `saved task ${out.task_id} "${out.title}"`;
  return JSON.stringify(out).slice(0, 160);
}

// ---------- executor ----------

async function log(ctx, tool, args, status, result) {
  try {
    await ctx.sql`
      insert into logs (user_id, tool, args, status, result)
      values (${ctx.user.id}, ${tool}, ${JSON.stringify(args ?? {})}::jsonb, ${status}, ${String(result).slice(0, 1000)})`;
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
    const out = await v.tool.run(ctx, v.args);
    const summary = summarize(v.name, out);
    await log(ctx, v.name, call.args, "ok", summary);
    return { tool: v.name, args: call.args, status: "ok", result: out, summary };
  } catch (e) {
    await log(ctx, v.name, call.args, "error", e.message);
    return { tool: v.name, args: call.args, status: "error", result: e.message, summary: e.message };
  }
}
