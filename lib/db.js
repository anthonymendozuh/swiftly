import { neon } from "@neondatabase/serverless";

let sql;
let ready;

export function db() {
  if (!sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    sql = neon(url);
  }
  return sql;
}

// tables are created on first request, no migration step
export function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      const s = db();
      await s`create table if not exists users (
        id serial primary key, email text unique not null, pass_hash text not null,
        city text not null, lat double precision not null, lon double precision not null,
        tz text not null, created_at timestamptz default now())`;
      await s`create table if not exists tasks (
        id serial primary key, user_id int not null references users(id) on delete cascade,
        title text not null, category text not null, duration_min int not null,
        outdoor boolean not null default false, created_at timestamptz default now())`;
      await s`create table if not exists events (
        id serial primary key, user_id int not null references users(id) on delete cascade,
        task_id int references tasks(id) on delete set null, title text not null, date text not null,
        start_min int not null, end_min int not null, kind text not null, category text not null default 'other')`;
      await s`create table if not exists logs (
        id serial primary key, user_id int not null references users(id) on delete cascade,
        ts timestamptz default now(), tool text not null, args jsonb, status text not null, result text)`;
      // added later: trail notes on events, undo payloads on log rows
      await s`alter table events add column if not exists note text`;
      await s`alter table logs add column if not exists undo jsonb`;
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
