"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const HOUR_START = 6;
const HOUR_END = 24;
const HOUR_PX = 44;

const EXAMPLES = [
  "Work Mon, Wed, Fri 2pm–10pm and class Tue/Thu 9am–12pm. This week I want to run 3 times, do a long hike, study 4 hours for my ML exam, and get groceries.",
  "What's the best day this week for a hike?",
  "It might rain Thursday. Move anything outdoor off that day.",
  "Clear my Saturday.",
];

const PROGRESS = ["Reading your week…", "Checking the forecast…", "Finding open time…", "Writing to your calendar…", "Double-checking…"];

const fmtTime = (min) => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${((h + 11) % 12) + 1}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`;
};

const icon = (code) =>
  code == null ? "" : code <= 1 ? "☀️" : code === 2 ? "⛅" : code === 3 ? "☁️" : code <= 48 ? "🌫️" : code >= 95 ? "⛈️" : code >= 71 && code <= 86 && ![80, 81, 82].includes(code) ? "🌨️" : "🌧️";

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export default function Home() {
  const [week, setWeek] = useState(null);
  const [authed, setAuthed] = useState(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    const r = await api("/api/week");
    if (r.status === 401) return setAuthed(false);
    if (!r.ok) return setLoadError(r.data.error || "Couldn't load your week.");
    setLoadError("");
    setAuthed(true);
    setWeek(r.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (authed === false) return <Auth onDone={load} />;
  if (loadError) return <div className="center"><div className="card"><h2>Setup needed</h2><p className="muted">{loadError}</p></div></div>;
  if (!week) return <div className="center muted">Loading…</div>;
  return <Planner week={week} reload={load} onLogout={() => { setWeek(null); setAuthed(false); }} />;
}

function Auth({ onDone }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", city: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const r = await api(`/api/auth/${mode}`, form);
    setBusy(false);
    if (!r.ok) return setErr(r.data.error || "Something went wrong.");
    onDone();
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="center auth">
      <div className="hero">
        <Logo />
        <h1>Plan your week around<br /><em>the weather.</em></h1>
        <p className="muted">Tell Swiftly your schedule and to-dos. The agent checks the forecast, finds open time, and puts hikes and runs on the best days, right on your calendar.</p>
      </div>
      <form className="card" onSubmit={submit}>
        <div className="seg">
          <button type="button" aria-pressed={mode === "login"} onClick={() => setMode("login")}>Log in</button>
          <button type="button" aria-pressed={mode === "signup"} onClick={() => setMode("signup")}>Sign up</button>
        </div>
        <label>Email<input type="email" required value={form.email} onChange={set("email")} autoComplete="email" /></label>
        <label>Password<input type="password" required minLength={6} value={form.password} onChange={set("password")} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
        {mode === "signup" && <label>City<input required placeholder="e.g. Pomona" value={form.city} onChange={set("city")} /></label>}
        {err && <div className="error">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? "…" : mode === "login" ? "Log in" : "Create account"}</button>
      </form>
    </div>
  );
}

function Logo() {
  return (
    <div className="logo">
      <span className="logo-mark" aria-hidden>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M3 17l5-6 4 4 4-7 5 9" />
        </svg>
      </span>
      Swiftly
    </div>
  );
}

function Planner({ week, reload, onLogout }) {
  const [messages, setMessages] = useState([
    { role: "assistant", text: "Hey! Tell me your schedule and what you want to get done this week. I'll check the weather and plan it out." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pending, setPending] = useState(null);
  const [tab, setTab] = useState("calendar");
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  useEffect(() => {
    if (!busy) return;
    setProgress(0);
    const t = setInterval(() => setProgress((p) => Math.min(p + 1, PROGRESS.length - 1)), 3500);
    return () => clearInterval(t);
  }, [busy]);

  async function send(text) {
    const msg = text.trim();
    if (!msg || busy) return;
    const history = messages.slice(1).map(({ role, text }) => ({ role, text }));
    setMessages((m) => [...m, { role: "user", text: msg }]);
    setInput("");
    setBusy(true);
    const r = await api("/api/agent", { message: msg, history });
    setBusy(false);
    if (r.status === 401) return onLogout();
    if (!r.ok) {
      setMessages((m) => [...m, { role: "assistant", text: r.data.error || "Something went wrong.", error: true }]);
      return;
    }
    setMessages((m) => [...m, { role: "assistant", text: r.data.reply, steps: r.data.steps }]);
    if (r.data.pending) setPending(r.data.pending);
    reload();
  }

  async function decide(confirm) {
    const p = pending;
    setPending(null);
    const r = await api("/api/confirm", { id: p.id, confirm });
    const text = r.ok ? (confirm ? `✓ Done: ${r.data.result}` : "Okay, I left everything as it was.") : r.data.error || "That didn't work.";
    setMessages((m) => [...m, { role: "assistant", text, error: !r.ok }]);
    reload();
  }

  async function logout() {
    await api("/api/auth/logout", {});
    onLogout();
  }

  const unscheduled = week.tasks.filter((t) => !t.scheduled);

  return (
    <div className="app">
      <header className="top">
        <Logo />
        <div className="top-meta">
          <span className="pill">📍 {week.user.city}</span>
          <a className="btn" href="/api/ics">Export to calendar</a>
          <button className="btn ghost" onClick={logout} title={week.user.email}>Log out</button>
        </div>
      </header>

      <div className="main">
        <section className="chat">
          <div className="thread">
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}${m.error ? " err" : ""}`}>
                <p>{m.text}</p>
                {m.steps?.length > 0 && <Steps steps={m.steps} />}
              </div>
            ))}
            {busy && (
              <div className="msg assistant working">
                <span className="spin" /> {PROGRESS[progress]}
              </div>
            )}
            {messages.length === 1 && !busy && (
              <div className="examples">
                {EXAMPLES.map((ex) => (
                  <button key={ex} onClick={() => send(ex)}>{ex}</button>
                ))}
              </div>
            )}
            <div ref={endRef} />
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <textarea
              rows={2}
              value={input}
              placeholder="e.g. I work Tue–Thu 3–11pm. Fit in 2 runs and a hike."
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
            />
            <button className="primary" disabled={busy || !input.trim()}>Send</button>
          </form>
        </section>

        <section className="board">
          <div className="tabs">
            <button aria-pressed={tab === "calendar"} onClick={() => setTab("calendar")}>Week</button>
            <button aria-pressed={tab === "log"} onClick={() => setTab("log")}>Activity log</button>
            <div className="legend">
              <span className="dot physical" />Physical <span className="dot mental" />Mental <span className="dot errand" />Errand <span className="dot fixed" />Commitment
            </div>
          </div>
          {tab === "calendar" ? (
            <>
              {unscheduled.length > 0 && (
                <div className="unscheduled">
                  <span className="muted">Not scheduled yet:</span>
                  {unscheduled.map((t) => (
                    <span key={t.id} className={`chip ${t.category}`}>{t.title} · {t.duration_min}m</span>
                  ))}
                </div>
              )}
              <Calendar week={week} />
            </>
          ) : (
            <Log logs={week.logs} />
          )}
        </section>
      </div>

      {pending && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="warn-icon">!</div>
            <h3>Confirm this change</h3>
            <p>{pending.description}</p>
            <p className="muted small">The agent asked to do this. It won't happen unless you confirm.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => decide(false)}>Cancel</button>
              <button className="danger" onClick={() => decide(true)}>Yes, delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_ICON = { ok: "✓", error: "✗", blocked: "⛔", pending: "⏸" };

function Steps({ steps }) {
  const actions = steps.reduce((n, s) => n + s.actions.length, 0);
  return (
    <details className="steps">
      <summary>Agent trace · {steps.length} step{steps.length > 1 ? "s" : ""} · {actions} action{actions === 1 ? "" : "s"}</summary>
      <ol>
        {steps.map((s, i) => (
          <li key={i}>
            {s.thought && <div className="thought">💭 {s.thought}</div>}
            {s.actions.map((a, j) => (
              <div key={j} className={`act ${a.status}`}>
                <span className="st">{STATUS_ICON[a.status] || "•"}</span>
                <code>{a.tool}</code>
                <span className="res">{a.summary}</span>
              </div>
            ))}
          </li>
        ))}
      </ol>
    </details>
  );
}

function Calendar({ week }) {
  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
  const height = hours.length * HOUR_PX;
  return (
    <div className="cal">
      <div className="cal-head">
        <div />
        {week.days.map((d) => (
          <div key={d.date} className={`day-head${d.date === week.today ? " today" : ""}`}>
            <div className="dname">{d.label} <b>{+d.date.slice(8)}</b></div>
            {d.weather && (
              <div className={`wx${d.weather.rain_chance >= 50 ? " wet" : ""}`} title={d.weather.summary}>
                {icon(d.weather.code)} {d.weather.high}° <span>{d.weather.rain_chance}%</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="cal-body">
        <div className="gutter" style={{ height }}>
          {hours.map((h) => (
            <div key={h} style={{ height: HOUR_PX }}>{fmtTime(h * 60)}</div>
          ))}
        </div>
        {week.days.map((d) => (
          <div key={d.date} className={`col${d.date === week.today ? " today" : ""}`} style={{ height }}>
            {hours.map((h) => <div key={h} className="line" style={{ top: (h - HOUR_START) * HOUR_PX }} />)}
            {week.events
              .filter((e) => e.date === d.date)
              .map((e) => {
                const top = ((Math.max(e.start_min, HOUR_START * 60) - HOUR_START * 60) / 60) * HOUR_PX;
                const h = Math.max(((Math.min(e.end_min, HOUR_END * 60) - Math.max(e.start_min, HOUR_START * 60)) / 60) * HOUR_PX - 2, 18);
                return (
                  <div key={e.id} className={`ev ${e.kind === "fixed" ? "fixed" : e.category}`} style={{ top, height: h }} title={`${e.title} ${fmtTime(e.start_min)}–${fmtTime(e.end_min)}`}>
                    <b>{e.title}</b>
                    <span>{fmtTime(e.start_min)}–{fmtTime(e.end_min)}</span>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Log({ logs }) {
  if (!logs.length) return <p className="muted pad">No actions yet. Everything the agent does will be recorded here.</p>;
  return (
    <div className="log">
      <table>
        <thead>
          <tr><th>Time</th><th>Action</th><th>Status</th><th>Details</th></tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="mono">{new Date(l.ts).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</td>
              <td><code>{l.tool}</code></td>
              <td><span className={`badge ${l.status}`}>{l.status}</span></td>
              <td className="details">{l.result}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
