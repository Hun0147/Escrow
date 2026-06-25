# PS5 Skill-Wager Escrow Platform (Phase 1 MVP)

Escrow-backed 1v1 skill wagers for PlayStation 5 competitive gaming. The
platform holds both players' stakes, and on settlement pays the winner the
pool minus a 12% platform fee.

Phase 1 scope only: registration, wallet, escrow, match creation, manual
dispute review. No PSN integration, no AI verification, no real payment
processor — those are Phase 2+ and require compliance review before any
real money moves (see "Before going live" below).

## Structure

- `apps/api` — Express + TypeScript REST API, backed by Postgres
  (`src/db/schema.sql`, applied via `npm run migrate --workspace=apps/api`).
- `apps/web` — Next.js web client.
- `packages/shared` — shared types and the settlement fee calculation
  (`calculateSettlement`), used by both API and any future client.

## Running

Requires a running Postgres instance. By default everything points at
`postgres://escrow:escrow@localhost:5432/escrow` (override with `DATABASE_URL`).

```bash
createuser escrow --pwprompt   # if the role doesn't exist yet
createdb escrow -O escrow

npm install
npm run build --workspace=packages/shared
npm run migrate --workspace=apps/api   # applies schema.sql, safe to re-run
npm run dev:api    # http://localhost:4000
npm run dev:web    # http://localhost:3000
```

## Tests

```bash
npm run test --workspace=apps/api
```

Runs against the same Postgres database (truncating tables between tests) —
covers the settlement math (12% fee) and the end-to-end create → fund →
settle flow against real SQL, not an in-memory stub. Multi-step operations
(funding, settlement, cancellation) run inside a single DB transaction with
row locking (`SELECT ... FOR UPDATE`) to stay correct under concurrent
requests; wallet balance changes are enforced non-negative at the SQL level
to avoid races.

## API

`/auth/*` is open. Every other route requires `Authorization: Bearer <token>`,
where the token comes from `/auth/register` or `/auth/login`. The
authenticated user's id is used as the acting identity (depositor, match
creator, funder, dispute raiser) — it is never taken from the request body.

| Method | Path                          | Purpose                          |
|--------|-------------------------------|-----------------------------------|
| POST   | `/auth/register`              | Create user, returns `{ user, token }` |
| POST   | `/auth/login`                 | Authenticate, returns `{ user, token }` |
| POST   | `/wallet/deposit`              | Add funds to caller's wallet       |
| POST   | `/wallet/withdraw`             | Withdraw funds from caller's wallet|
| GET    | `/wallet/balance`              | Get caller's balance               |
| POST   | `/matches`                     | Create a wager (caller is creator) |
| POST   | `/matches/:id/fund`            | Lock caller's stake into escrow    |
| POST   | `/matches/:id/settle`          | Release payout to winner (12% fee) — moderator-triggered, winner given explicitly |
| POST   | `/matches/:id/cancel`          | Cancel and refund                  |
| POST   | `/disputes`                    | Raise a dispute (caller is the raiser) |
| POST   | `/disputes/:id/resolve`        | Manual moderator resolution — not yet role-restricted |

## Before going live

This is a code scaffold, not a launch-ready product. Real-money skill
wagering is regulated as gambling/money-transmission in most US states and
many countries. Do not connect a real payment processor or accept real
deposits until you've confirmed licensing requirements in every
jurisdiction you operate in, and have AML/KYC and chargeback handling in
place.
