# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Telegram bot for managing IDF company (~80 soldiers) personnel status. Written in Node.js, hosted on Render, data stored in Supabase.

## Running the bot

```bash
npm start            # run locally (requires .env; same as `node bot.js`)
node --check bot.js  # syntax check without running
npm test             # run offline logic tests (test-bot.js) — no network/DB needed
```

No build step. Copy `.env.example` to `.env` and fill in the keys for local runs.

`bot.js` exports its pure helpers and only starts the bot when run directly
(`if (require.main === module) main()`), so `test-bot.js` can require and test
the logic (gatekeeper, name matching, date, report formatting, prompt building,
JSON parsing) without a token, Supabase, or Gemini key.

## Environment variables (`.env`, not committed)

| Variable | Purpose |
|---|---|
| `TELEGRAM_TOKEN` | BotFather token |
| `GEMINI_KEY` | Google Gemini API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase service role key |
| `DEPLOYMENT_NAME` | Operation name shown in reports (e.g. `שאגת הארי`) |
| `PORT` | Set by Render automatically |

## Architecture

Everything lives in `bot.js` (~390 lines). There are no modules, no routes file, no separate config.

**Message flow:**
1. Telegram sends POST to webhook → `bot.on("message")` fires
2. **Gatekeeper** filters group messages: only passes if starts with `*`, contains `דוח`, or is a `/` command
3. Private chat: only responds to `COMMANDER_ID = 434078287`
4. Strips `*` prefix, sends cleaned text to Gemini AI
5. AI returns JSON with `type` field → bot routes to the right handler

**AI (`askAi`):**
- Sends prompt to Gemini with full roster + Hebrew military context
- Returns structured JSON: `{type, updates, dates, unit, status, ...}`
- Tries 3 models in order: `gemini-flash-lite-latest` → `gemini-flash-latest` → `gemini-2.5-flash`
- 1.5s delay on 429/503 before trying next model

**Action types the AI returns:**
- `update` — update one or more soldiers (status + mission)
- `bulk_update` — update entire company or unit
- `show_report` — generate and send the formatted report
- `clear` — delete all report_data for a date
- `rename` / `add` — roster management (triggered by `***` prefix)
- `chat` — fallback, bot replies with `ai.text`

**Ambiguous name resolution:**
When a name matches multiple soldiers (e.g. "כהן" → 2 soldiers), the bot shows inline keyboard buttons instead of updating all matches. State is stored in `pendingConfirmations` Map (in-memory, keyed by `chatId`). The `callback_query` handler resolves selections one at a time. All pending updates (unambiguous + resolved) are written to Supabase only after the last confirmation.

**Supabase tables:**
- `soldiers` — roster: `name`, `unit`, `is_active`
- `report_data` — daily status: `name`, `status` (BASE/HOME), `mission`, `report_date`, `deployment_name`. Unique constraint on `(name, report_date)`.

Writes are batched: a whole `update`/`bulk_update` is one `upsert([...])` call per
run (not one call per soldier), with `onConflict: "name,report_date"` (no space —
PostgREST would otherwise read a non-existent ` report_date` column).

**Messages use `parse_mode: "HTML"`** (not legacy Markdown, which breaks on `**`).
All dynamic text is passed through `esc()` and sent via the `send()`/`edit()`
wrappers, which always `.catch()` Telegram errors so a parse failure can't go silent.

**Dates/times are computed in `Asia/Jerusalem`** via `Intl.DateTimeFormat`
(`getIsraelDate`, `israelNowParts`), independent of the server timezone — the
AI prompt and reports always get the correct Israel day/date even on a UTC host.

**Report generation (`generateFixedReport`):**
Iterates `VALID_UNITS` in order, then lists missions. Soldiers not in `report_data` for that date default to BASE.

**Cron jobs:**
- 18:00 Sun–Thu: reminder to send tomorrow's report
- 18:00 Fri: reminder to send weekend report
- Timezone: `Asia/Jerusalem`

## Deployment

Hosted on Render (`https://dvir-army-bot.onrender.com`). Auto-deploys from GitHub `main` branch on push.

**Webhook mode** (not polling) — avoids 409 conflicts during rolling deploys. Webhook is registered via `bot.setWebHook()` on startup. If the webhook goes missing (check with `getWebhookInfo`), re-register manually:

```bash
curl -X POST "https://api.telegram.org/bot{TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://dvir-army-bot.onrender.com/bot{TOKEN}"}'
```

A cron-job.org job pings the service every 10 minutes to prevent Render free tier sleep.

## Key constraints

- **AI must not complete partial names**: The prompt instructs Gemini to return partial names (e.g. "כהן") as-is, not completed to a full name. This is what allows the ambiguous name detection to work.
- **`pendingConfirmations` is in-memory**: Lost on restart. If a user clicks an old button after a deploy, they see "הפעולה פגה תוקף".
- **Group activation key**: Messages in group chats must start with `*` to be processed. `***` prefix is for roster management commands (add/rename).
