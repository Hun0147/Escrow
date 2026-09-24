# Deploying Goal 27

Two pieces, two hosts, because they are two different kinds of program.

| Piece | Where | Why |
|---|---|---|
| `apps/web` — Next.js client | **Vercel** | Static pages and server components; exactly what Vercel is for |
| `apps/api` — Express + Socket.io + workers | **A container host** (Render, Railway, Fly.io) | Holds open websockets and runs timers; a serverless function does neither |
| PostgreSQL | Managed (Render, Neon, Supabase, Railway) | The ledger is the product. It needs a real database, not a file |

Vercel cannot host the API. Not a limitation to work around — a Socket.io
connection has to live somewhere that a function invocation does not, and the
OCR worker, reporting-deadline sweep and subscription renewals are loops on a
clock. `apps/api/Dockerfile` runs identically on any container host.

---

## 1. Database

Create a managed PostgreSQL 14+ and keep its connection string. Nothing else to
do: the API applies its migrations on boot, in filename order, each in its own
transaction, tracked in `schema_migrations`.

## 2. API

Render reads `render.yaml` as a blueprint (service + database + disk). On
Railway or Fly, point the host at `apps/api/Dockerfile` with the repository
root as the build context.

Environment:

| Variable | Set it to |
|---|---|
| `DATABASE_URL` | the managed database's connection string |
| `JWT_SECRET` | a long random value. **The development default must not survive deployment** |
| `WEB_ORIGIN` | the Vercel URL, e.g. `https://goal27.vercel.app` — this is the CORS origin |
| `PORT` | whatever the host expects (4000 in the blueprint) |
| `DISCORD_BOT_TOKEN` / `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | optional; all three or DMs stay off |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | optional; both or payments stay on the mock provider |

Keep it to **one instance**. The realtime bus is an in-process EventEmitter, so
a second instance silently drops events for players connected to the first. It
needs the Socket.io Redis adapter before it scales out.

## 3. Web

Import the repository into Vercel with the **repository root** as the root
directory — `vercel.json` handles the rest, because `apps/web` imports the
build output of `packages/shared` and that has to be built first.

Set one variable:

    NEXT_PUBLIC_API_URL = https://<your-api-host>

It is read **at build time**. Change it and you must redeploy; get it wrong and
you get a site that renders perfectly and cannot log in.

---

## What is real, and what is still a stand-in

Everything about the money is real. The double-entry ledger, escrow, the
agreement-or-ruling release path, the escrow fee, trust scoring, the dispute
queue, screenshot hashing and duplicate detection, the trust-driven settlement
policy — all of it runs the same code the 188 tests exercise against a real
PostgreSQL. A deployment starts with an empty database and every row in it is
produced by someone actually using the app.

Four things are stand-ins, and each one announces itself:

- **Payments.** Without Stripe keys the provider is a mock: it writes a real
  payment-intent record and confirms it, so deposits and withdrawals move real
  ledger money, but no card is ever charged. This is the right setting for a
  test deployment — see the warning below before changing it.
- **Evidence storage.** Screenshots are written to disk. A container
  filesystem is ephemeral, so without the mounted volume in `render.yaml` a
  redeploy destroys the evidence a dispute depends on. `EvidenceStore` is two
  methods and S3 drops straight in; do that before anyone disputes anything
  that matters.
- **OCR.** The default engine is a development stub that reads a text sidecar,
  so the pipeline runs anywhere. `OCR_ENGINE=tesseract` swaps in real
  recognition; the parsing and comparison logic is engine-independent.
- **Email, SMS and KYC documents.** Stubs that set the flags the platform
  reads.

Do **not** run `npm run seed` against a deployment. It creates the demo players
and fixtures for local development; a live database should start empty.

## Before you take a real payment

Paid entry-fee contests are regulated as gambling or money transmission in many
jurisdictions, and the seeded blocked-region list is a starting point for a
compliance review, not legal advice. The Stripe code has never spoken to
Stripe — the signature checks, idempotency and reversal are tested, but the two
REST calls were written against the docs. Exercise them against test keys
first, and read the "Before going live" section of the README.
