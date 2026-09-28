# Deploying the backend

## Local test (already verified)

```bash
pnpm install
pnpm --filter api build
pnpm --filter api start:prod   # runs dist/main.js
```

Confirmed working: chat streaming, product list, escalation, CORS (multi-origin).

## Where to host it

**Not Vercel** — this backend uses Server-Sent Events (a long-lived streaming HTTP response),
which doesn't fit Vercel's serverless function model (short execution limits, no real
persistent connections). Any host that runs a normal long-lived Node process works: Railway,
Render, Fly.io, a Google Cloud Run container, or a plain VPS. A `Dockerfile` is included at
`apps/api/Dockerfile` (build context = repo root) — works with any of those.

```bash
docker build -f apps/api/Dockerfile -t austyle-api .
docker run -p 3001:3001 --env-file apps/api/.env austyle-api
```

## Required environment variables

Set these on whatever host you pick (same as `.env`):

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | `https://plwhvqtcvdacmlnpiife.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase dashboard → this project → Settings → API Keys |
| `GEMINI_API_KEY` | |
| `RESEND_API_KEY` | optional — without it, escalations save to the DB but no email sends |
| `ESCALATION_FROM_EMAIL` | only matters if `RESEND_API_KEY` is set |
| `ESCALATION_TO_EMAIL` | same |
| `PORT` | most hosts inject this automatically — `main.ts` already reads `process.env.PORT` |
| `WEB_ORIGIN` | comma-separated frontend origin(s), e.g. `https://your-app.vercel.app` — **update this once you have the real Vercel URL**, otherwise the browser will block every request with a CORS error |

## After you have the Vercel URL

Tell me the URL and I'll update `WEB_ORIGIN` (add it alongside `localhost:3000` so local dev
keeps working too).
