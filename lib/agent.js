import { generate } from "./llm";
import { execute } from "./tools";
import { systemPrompt } from "./prompt";
import { todayIn, nowMinIn } from "./time";
import { forecast } from "./weather";

const MAX_STEPS = 8;

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
  let fc;
  return {
    sql,
    user,
    today: todayIn(user.tz),
    forecast: () => (fc ??= forecast(user.lat, user.lon, user.tz).catch(() => null)),
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
  const contents = [...cleanHistory(history), { role: "user", parts: [{ text: message }] }];
  const steps = [];

  for (let i = 0; i < MAX_STEPS; i++) {
    const raw = await generate(system, contents);
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

  return { reply: "I hit my step limit. Here's what I got done so far. Ask me to keep going if something is missing.", steps, pending: null };
}
