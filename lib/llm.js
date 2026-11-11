// gemini rest call with retries + model fallback (busy / rate limited / retired models)
const MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
].filter((m, i, a) => m && a.indexOf(m) === i);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LLMError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function generate(system, contents, deadline = Date.now() + 50_000) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new LLMError("GEMINI_API_KEY is not set", 500);

  const base = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
  };
  // low thinking = much faster replies; dropped automatically if a model rejects it
  let fast = true;
  const body = () =>
    JSON.stringify(fast ? { ...base, generationConfig: { ...base.generationConfig, thinkingConfig: { thinkingLevel: "low" } } } : base);

  let last = { status: 0, message: "" };
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 4000) throw new LLMError("out of time", 504);
      let res;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: body(),
          signal: AbortSignal.timeout(Math.min(25000, left - 1000)),
        });
      } catch {
        last = { status: 502, message: "could not reach gemini" };
        await sleep(600);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        if (text) return text;
        last = { status: 502, message: "empty response from gemini" };
        continue;
      }
      last = { status: res.status, message: data?.error?.message || `gemini error ${res.status}` };
      if (res.status === 401 || res.status === 403) throw new LLMError("gemini rejected the api key", res.status);
      if (res.status === 400 && fast && /think/i.test(last.message)) {
        fast = false;
        attempt--;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(800 * (attempt + 1)); // backoff, then retry / next model
        continue;
      }
      break; // 400/404: this model won't work, try the next one
    }
  }
  const friendly =
    last.status === 429 ? "AI rate limit hit, wait a minute and try again." :
    last.status >= 500 ? "AI service is busy, try again in a few seconds." : last.message;
  throw new LLMError(friendly, last.status || 502);
}
