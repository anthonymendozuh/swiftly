# swiftly: ai weekly planning agent

tell it your schedule and to-dos in plain english. the agent checks the weather, finds open time, and writes the plan to your calendar. hikes and runs land on dry, mild days, and studying goes on rainy ones.

## what it does
- natural language in: "work mon/wed 2-10pm, run 3x, long hike, study 4h"
- agent loop (reason → act → observe), up to 8 steps per request
- real actions: weather api calls, database writes (commitments, tasks, calendar blocks), moves, deletes, .ics export
- login per user, weekly calendar view, agent trace under every reply, activity log tab

## agent architecture
| part | file |
|---|---|
| llm integration (gemini, retries, model fallback, rate limits) | `lib/llm.js` |
| prompt (persona, react loop, json template, rules, few-shot) | `lib/prompt.js` |
| action interpreter / executor + tool registry | `lib/tools.js` |
| agent loop | `lib/agent.js` |
| ui | `app/page.js` |

## safety
- every llm reply is parsed + shape-checked; invalid json gets re-asked
- every action is validated: known tool, typed args, date inside the window, no past times, no overlaps, user can only touch their own rows
- commitments can't be moved by the agent
- destructive tools (`delete_event`, `clear_day`, `delete_task`) never run directly. they become a pending action that the user confirms in a popup (expires in 15 min)
- outdoor slots get weather warnings (rain, heat, darkness) fed back to the agent
- every request, action, block, error, confirm and cancel is written to the `logs` table (activity log tab)
- per-user request throttle

## run it
needs a free gemini key (aistudio.google.com/app/apikey) and a postgres url (neon free tier). tables are created automatically.

```bash
npm install
cp .env.example .env.local   # fill in GEMINI_API_KEY and DATABASE_URL
npm run dev
```

## deploy (vercel)
1. import the repo at vercel.com/new
2. add env var `GEMINI_API_KEY`
3. project → storage → create database → neon (adds `DATABASE_URL`)
4. redeploy
