import { NextResponse } from "next/server";

export const json = (data, status = 200, headers) => NextResponse.json(data, { status, headers });

// in-memory per-user throttle (per server instance)
const hits = new Map();
export function throttle(key, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) return false;
  arr.push(now);
  hits.set(key, arr);
  return true;
}

export function serverError(e) {
  console.error(e);
  const msg = /DATABASE_URL/.test(e?.message) ? "Database isn't connected (DATABASE_URL missing)." : e?.message || "Something went wrong.";
  return json({ error: msg }, e?.status && e.status >= 400 && e.status < 600 ? e.status : 500);
}
