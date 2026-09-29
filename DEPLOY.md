# Deploying the backend

This folder is a **standalone repo** — its own `.git`, own `pnpm-lock.yaml`, no dependency on
the parent monorepo. Push this folder to GitHub as its own repository and deploy from there.

## Local test (already verified)

```bash
pnpm install
pnpm build
pnpm start:prod   # runs dist/main.js
```

Confirmed working: chat streaming, product recommendations, image upload + vision recognition,
escalation, CORS (multi-origin), classified error codes (invalid key, rate limit) — all tested
end-to-end against this exact standalone build.

## Where to host it

**Not Vercel** — this backend uses Server-Sent Events (a long-lived streaming HTTP response),
which doesn't fit Vercel's serverless function model (short execution limits, no real
persistent connections). Any host that runs a normal long-lived Node process works: Railway,
Render, Fly.io, a Google Cloud Run container, or a plain VPS. `Dockerfile` builds this folder
as-is:

```bash
docker build -t austyle-api .
docker run -p 3001:3001 --env-file .env austyle-api
```

## Railway

Push this folder as its own GitHub repo, then in Railway: New Project → Deploy from GitHub repo
→ pick it. Railway auto-detects the `Dockerfile` at the repo root — no extra config needed.

## Required environment variables

Set these in Railway → your service → Variables (same as `.env`):

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | `https://plwhvqtcvdacmlnpiife.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase dashboard → this project → Settings → API Keys |
| `OPENAI_API_KEY` | used for chat generation and image/vision recognition (`gpt-4o-mini`) |
| `RESEND_API_KEY` | optional — without it, escalations save to the DB but no email sends |
| `ESCALATION_FROM_EMAIL` | only matters if `RESEND_API_KEY` is set |
| `ESCALATION_TO_EMAIL` | same |
| `PORT` | Railway injects this automatically — `main.ts` already reads `process.env.PORT` |
| `WEB_ORIGIN` | comma-separated frontend origin(s), e.g. `https://your-app.vercel.app` — **update this once you have the real Vercel URL**, otherwise the browser will block every request with a CORS error |

## After you have the Vercel URL

Tell me the URL and I'll update `WEB_ORIGIN` (add it alongside `localhost:3000` so local dev
keeps working too).
