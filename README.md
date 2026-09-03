# Standup → Jira

Turns production-standup email notes into Jira issues, automatically:

- **AI extraction** — email HTML → structured tickets (topic, owner, status, priority, dated updates).
- **Formatting-aware** — `<strike>` → `Done`; **bold + red** → `Highest` priority.
- **De-duplication** — the same topic each morning updates the same ticket instead of creating a duplicate.
- **Dynamic assignee** — the owner name is resolved to a Jira `accountId` and assigned.
- **Real @mentions** — every `@Person` in an update becomes a true mention, so those people get **notified**. Multiple people per line are supported.
- **Conflict-aware sync** — before changing status or assignee, Jira's current values are read first. An issue manually marked **Done** in Jira is never reopened, and a manual reassignment is never silently overwritten. Any mismatch between what the email says and what Jira has is logged (`[CONFLICT] ...` in the function logs, and in `results[].conflicts` in the API response) for review.

Power Automate is reduced to two steps: *email trigger → one HTTP POST*. All logic lives in this code.

---

## One-time setup

```bash
npm install                 # install dependencies
copy .env.example .env       # (Windows)  create your env file, then fill it in
```

Fill `.env`:
- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (create at https://id.atlassian.com/manage-profile/security/api-tokens), `JIRA_PROJECT_KEY`
- `AI_MODEL` — e.g. `openai/gpt-4o-mini` (works on the free AI Gateway tier)
- `AI_GATEWAY_API_KEY` — only for local dev (create in Vercel → AI Gateway → API Keys)
- `WEBHOOK_SECRET` — any long random string

Fill `lib/people.json` — map each person's name to their Jira **email**. The accountId is looked up automatically:
```json
{
  "Aleksandra": { "email": "aleksandra@company.com" },
  "Darija":     { "email": "darija@company.com" }
}
```
> Everyone you want to assign or @mention must be an invited Jira user **with access to the project**.

---

## Everyday commands

> On Windows PowerShell use `curl.exe` (not `curl`) or `Invoke-RestMethod`. All commands run from the project root.

### Run the server locally
```bash
vercel dev
```
Leave it running; it serves `http://localhost:3000/api/process`.
(After changing `.env`, stop with **Ctrl+C** and run `vercel dev` again.)

### Send a test standup (PowerShell)
```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/process" -Method Post `
  -Headers @{"x-webhook-secret"="YOUR_SECRET"} -ContentType "application/json" `
  -Body '{"html":"1. Overflow on Solder Wave - Aleksandra<br>26/08/2026 - progress. @Darija please review by 28.08"}'
```

### See the full result (who got notified, etc.)
```powershell
$r = Invoke-RestMethod -Uri "http://localhost:3000/api/process" -Method Post `
  -Headers @{"x-webhook-secret"="YOUR_SECRET"} -ContentType "application/json" `
  -Body '{"html":"1. Test issue - Aleksandra<br>26/08/2026 - check. @Darija review"}'
$r.results | ConvertTo-Json -Depth 5
```

### Check your AI Gateway balance
```bash
node --env-file=.env check-balance.mjs
```

### Delete Jira issues (bypasses the UI permission problem)
```bash
node --env-file=.env delete-issues.mjs --all --dry-run     # list what WOULD be deleted (safe)
node --env-file=.env delete-issues.mjs --all               # delete ALL issues in the project
node --env-file=.env delete-issues.mjs SAC-20 SAC-21       # delete specific keys
```

### Look up a person's Jira accountId (by name/email)
```powershell
$token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$env:JIRA_EMAIL:YOUR_JIRA_TOKEN"))
Invoke-RestMethod -Uri "https://YOURSITE.atlassian.net/rest/api/3/user/search?query=Darija" `
  -Headers @{"Authorization"="Basic $token"} | Select-Object displayName, accountId, active, emailAddress
```

### Check the code compiles
```bash
npm run typecheck
```

---

## Deploy (make it run 24/7)

```bash
npm i -g vercel        # once
vercel                  # first run links the project
vercel --prod           # deploy
```

Then in the Vercel dashboard → Project → **Settings → Environment Variables**, add the same values as `.env`
(except `AI_GATEWAY_API_KEY` — on Vercel it's automatic). Enable **AI Gateway** for the project.

### Wire up Power Automate (the only step left there)
Replace everything after the email trigger with one **HTTP** action:
- **Method**: POST
- **URI**: `https://<your-app>.vercel.app/api/process`
- **Headers**: `Content-Type: application/json`, `x-webhook-secret: YOUR_SECRET`
- **Body**: `{ "html": <email Body dynamic content> }`

---

## Project layout

```
api/process.ts     — main handler: extract → dedupe → assign → comment/mention
lib/ai.ts          — AI extraction (schema + prompt)
lib/jira.ts        — Jira REST calls (search, create, assign, status/transitions, comment, delete, accountId lookup)
lib/adf.ts         — builds ADF comments with real mentions
lib/people.ts      — name → email resolver
lib/people.json    — the people table (edit this to add teammates)
check-balance.mjs  — check AI Gateway credit
delete-issues.mjs  — delete issues from the CLI
```

## Adding a teammate
1. Invite them to Jira and give them access to the project.
2. Add one line to `lib/people.json`: `"Their Name": { "email": "their@email.com" }`.
That's it — the code finds their accountId automatically.