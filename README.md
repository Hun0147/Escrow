# PS5 Skill-Wager Escrow Platform (Phase 1 MVP)

Escrow-backed 1v1 skill wagers for PlayStation 5 competitive gaming. The
platform holds both players' stakes, and on settlement pays the winner the
pool minus a 12% platform fee.

Phase 1 scope only: registration, wallet, escrow, match creation, manual
dispute review. No PSN integration, no AI verification, no real payment
processor — those are Phase 2+ and require compliance review before any
real money moves (see "Before going live" below).

## Structure

- `apps/api` — Express + TypeScript REST API. In-memory store for now
  (see `src/db/schema.sql` for the Postgres schema to swap in).
- `apps/web` — Next.js web client.
- `packages/shared` — shared types and the settlement fee calculation
  (`calculateSettlement`), used by both API and any future client.

## Running

```bash
npm install
npm run build --workspace=packages/shared
npm run dev:api    # http://localhost:4000
npm run dev:web    # http://localhost:3000
```

## Tests

```bash
npm run test --workspace=apps/api
```

Covers the settlement math (12% fee) and the end-to-end create → fund → settle flow.

## API

| Method | Path                          | Purpose                          |
|--------|-------------------------------|-----------------------------------|
| POST   | `/auth/register`              | Create user                       |
| POST   | `/auth/login`                 | Authenticate                      |
| POST   | `/wallet/deposit`              | Add funds to wallet                |
| POST   | `/wallet/withdraw`             | Withdraw funds                     |
| GET    | `/wallet/:userId/balance`      | Get balance                        |
| POST   | `/matches`                     | Create a wager                     |
| POST   | `/matches/:id/fund`            | Lock a player's stake into escrow  |
| POST   | `/matches/:id/settle`          | Release payout to winner (12% fee) |
| POST   | `/matches/:id/cancel`          | Cancel and refund                  |
| POST   | `/disputes`                    | Raise a dispute                    |
| POST   | `/disputes/:id/resolve`        | Manual moderator resolution        |

## Before going live

This is a code scaffold, not a launch-ready product. Real-money skill
wagering is regulated as gambling/money-transmission in most US states and
many countries. Do not connect a real payment processor or accept real
deposits until you've confirmed licensing requirements in every
jurisdiction you operate in, and have AML/KYC and chargeback handling in
place.
