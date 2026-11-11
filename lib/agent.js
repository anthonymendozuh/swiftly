import { generate } from "./llm";
import { execute } from "./tools";
import { systemPrompt } from "./prompt";
import { todayIn, nowMinIn } from "./time";
import { forecast, airQuality } from "./weather";
import { nearbyTrails } from "./trails";

const MAX_STEPS = 10;
const TIME_BUDGET_MS = Number(process.env.AGENT_BUDGET_MS) || 38_000; // don't start a new step after this
const HARD_LIMIT_MS = 54_000; // vercel cuts requests at 60s; the ui auto-continues

export const CONTINUE_MSG = "Continue my last request from where you stopped. Use the fresh state below, don't redo finished work.";

export function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
  }
  return null;
}

export function makeContext(sql, user) {
  let fc, air;
  const trails = {};
  return {
    sql,
    user,
    today: todayIn(user.tz),
    undo: null,
    forecast: () => (fc ??= forecast(user.lat, user.lon, user.tz).catch(() => null)),
    air: () => (air ??= airQuality(user.lat, user.lon, user.tz).catch(() => null)),
    trails: (radius) => (trails[radius] ??= nearbyTrails(user.lat, user.lon, radius)),
  };
}

// gemini needs alternating user/model turns that start with user
function cleanHistory(history) {
  const out = [];
  for (const h of Array.isArray(history) ? history.slice(-8) : []) {
    const role = h?.role === "assistant" ? "model" : "user";
    const text = String(h?.text || "").slice(0, 2000);
    if (!text) continue;
    if (!out.length && role === "model") continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].parts[0].text += "\n" + text;
    else out.push({ role, parts: [{ text }] });
  }
  if (out.length && out[out.length - 1].role === "user") out.pop();
  return out;
}

export async function runAgent({ sql, user, message, history }) {
  const ctx = makeContext(sql, user);
  const system = systemPrompt({ user, today: ctx.today, nowMin: nowMinIn(user.tz) });
  const steps = [];
  const started = Date.now();

  // gather fresh state up front so the model can act in its first reply (saves a round trip)
  const pre = { thought: "gathering my week, the forecast and air quality", actions: [] };
  const state = {};
  for (const tool of ["get_week", "get_forecast", "get_air_quality"]) {
    const r = await execute(ctx, { tool, args: {} });
    pre.actions.push({ tool: r.tool, args: {}, status: r.status, summary: r.summary });
    state[tool] = r.status === "ok" ? r.result : `unavailable: ${r.result}`;
  }
  steps.push(pre);

  const first = `${message}\n\nCURRENT STATE (fresh, no need to fetch again unless something changed): ${JSON.stringify(state)}`;
  const contents = [...cleanHistory(history), { role: "user", parts: [{ text: first }] }];
  const partial = () => ({ reply: "", steps, pending: null, partial: true });

  for (let i = 0; i < MAX_STEPS; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) return partial();
    let raw;
    try {
      raw = await generate(system, contents, started + HARD_LIMIT_MS);
    } catch (e) {
      if (e.status === 504 || (steps.length > 1 && e.status >= 500)) return partial(); // keep what's done, continue next request
      throw e;
    }
    const out = parseJSON(raw);
    contents.push({ role: "model", parts: [{ text: raw }] });

    // validate the llm output shape before doing anything with it
    if (!out || typeof out !== "object" || (out.actions !== undefined && !Array.isArray(out.actions))) {
      steps.push({ thought: "(reply was not valid json, asking again)", actions: [] });
      contents.push({ role: "user", parts: [{ text: "Your last reply was not a valid json object in the required format. Reply again." }] });
      continue;
    }

    const actions = (out.actions || []).slice(0, 15);
    const step = { thought: String(out.thought || ""), actions: [] };
    steps.push(step);

    if (!actions.length) return { reply: String(out.message || "Done."), steps, pending: null };

    const observations = [];
    for (const call of actions) {
      const r = await execute(ctx, call);
      step.actions.push({ tool: r.tool, args: r.args, status: r.status, summary: r.summary });
      observations.push({ tool: r.tool, status: r.status, result: r.result });
      if (r.status === "pending") {
        // destructive: stop the loop and hand the decision to the user
        return {
          reply: String(out.message || "I need your OK before deleting anything."),
          steps,
          pending: { id: r.pending_id, description: r.summary },
        };
      }
    }

    if (out.done) return { reply: String(out.message || "Done."), steps, pending: null };
    contents.push({ role: "user", parts: [{ text: "OBSERVATIONS: " + JSON.stringify(observations) }] });
  }

  return partial();
}
