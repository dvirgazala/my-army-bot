# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Telegram bot for managing an IDF company (~83 soldiers) personnel status ("דוח 1").
Written in Node.js, hosted on Render, data in Supabase. **Deterministic-first** — Hebrew
commands are parsed in code (names, status, missions, dates, bulk, roster ops), including
fuzzy name matching (spelling variants, nicknames). The bot always works with no LLM.
An **optional AI fallback** (Claude via `ANTHROPIC_API_KEY`, else Gemini via `GEMINI_KEY`)
runs only when the deterministic engine can't parse a message — for free-form phrasing and
hard name mapping. Destructive actions (clear/bulk) are deterministic-only, never from the AI.

## Running the bot

```bash
npm start            # run locally (requires .env; same as `node bot.js`)
node --check bot.js  # syntax check
npm test             # 47 offline logic tests (test-bot.js) — no network/DB/LLM
```

Copy `.env.example` to `.env` and fill the keys. `bot.js` exports its pure helpers and
only starts the bot via `if (require.main === module) main()`, so `test-bot.js` tests the
parser, matcher, date logic and report builder with zero I/O.

## Environment variables (`.env`, not committed)

| Variable | Purpose |
|---|---|
| `TELEGRAM_TOKEN` | BotFather token |
| `SUPABASE_URL` / `SUPABASE_KEY` | Supabase project URL + service role key |
| `DEPLOYMENT_NAME` | Operation name shown in reports (e.g. `שאגת הארי`) |
| `PORT` | Set by Render automatically |

There is **no** `GEMINI_KEY` / LLM key — the bot does not call any AI service.

## Architecture

Everything is in `bot.js`. Pure helpers at the top; `main()` holds all side effects
(Supabase client, bot, webhook, cron, handlers).

**Message flow:**
1. Telegram webhook → `bot.on("message")`.
2. **Gatekeeper** (`passesGatekeeper`): in groups, only messages starting with `*`,
   a `בבית:`/`בבסיס:` block, containing `דוח`, or a `/` command pass.
3. Private chat: only `COMMANDER_ID = 434078287`.
4. Strip `*` (or `***` for roster commands) → `parseCommand(clean, roster, isRosterCmd)`.

**`parseCommand` (the deterministic engine)** returns an action:
- `clear` — איפוס/מחיקה + דוח.
- `bulk_update` — `כולם` / `כל מחלקה N` (+ status).
- `update` — `{ready, ambiguous, unknown, dates}`. Names resolved against the roster;
  partial names matching several soldiers go to `ambiguous` (inline-keyboard disambiguation).
- `show_report` — contains `דוח` / `שלח` / `מצב` and no soldier updates.
- `rename` / `add` — roster management (triggered by `***`).
- `unknown` — nothing recognized; bot replies with usage examples.

Parsing pieces (all pure, all tested): `resolveDate` (היום/מחר/מחרתיים/weekday/dd.mm,
Asia/Jerusalem), `detectStatus` (בבית→HOME, בבסיס→BASE), `detectMission` (matches the
`MISSIONS` list, handles prefixes like "בסיור 1"), `matchSoldiers` (exact preferred, else
partial), `tokensToNames` (merges two words only if they are an exact full name),
`parseHeaderList` + `parseTrailing` (the two common report formats), `STOP_WORDS` + `hw()`
(Hebrew word boundaries — JS `\b` does not work on Hebrew).

**Units (`VALID_UNITS`):** `מפל"ג, מחלקה 1, מחלקה 2, מחלקה 3, חובשים, חמ"ל`.
מסופחים (attached soldiers) are folded into the platoon they sit under; חובשים are separate.

**Missions (`MISSIONS`, 15):** חפ"ק מ"פ/סמ"פ, רספ, פ"פ, קצין מוצב, ש"ג 4-8, סיור 1/2,
כרמל, חובש פלוגתי, עמדת בת חפר, תורן לוגיסטיקה, תורן רחפן, נהג תורן, חמ"ל. (Source: the
"תקן יומי בחן" sheet. No truck-driver missions anymore.)

**Supabase tables:**
- `soldiers` — roster: `name`, `unit`, `is_active`. Seeded from the "טופס יציאות" sheet
  (minus the "אליס" company). See `db/`.
- `report_data` — daily status: `name`, `status` (BASE/HOME), `mission`, `report_date`,
  `deployment_name`. Unique `(name, report_date)`. Writes are batched; `onConflict:"name,report_date"`.

**Report (`generateReport`, full format, HTML):** per unit lists בבסיס + בבית with counts,
then a missions section (only assigned missions), then a total present/roster summary. All
messages use `parse_mode: "HTML"` with `esc()`; sends/edits are wrapped to `.catch()` errors.
Soldiers absent from `report_data` for a date default to BASE.

**Cron:** 18:00 Sun–Thu reminder for tomorrow; 18:00 Fri weekend reminder. `Asia/Jerusalem`.

## Deployment

Render (`https://dvir-army-bot.onrender.com`), auto-deploy from GitHub `main`. Webhook mode;
`bot.setWebHook()` runs on startup. Re-register manually if needed:

```bash
curl -X POST "https://api.telegram.org/bot{TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://dvir-army-bot.onrender.com/bot{TOKEN}"}'
```

A cron-job.org job pings every 10 min to keep the Render free tier awake.

## Data / roster

`db/schema.sql` (safe) creates the tables. `db/seed_soldiers.sql` (PII — gitignored, local
only) seeds the 83-soldier roster, generated from the "טופס יציאות" Google Sheet excluding
the "אליס" company. Regenerate from the sheet if the roster changes.
