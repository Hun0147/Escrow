# Goal 27

Skill-based competitive gaming for PS5. Two players agree a stake and a set of
rules, play each other on EA Sports FC on their own consoles, report the score,
and the winner's wallet is credited within minutes minus the platform rake.

Both stakes sit in escrow from the moment the second player joins. **Escrow only
releases on agreement between the two players or on a moderator's ruling** —
there is no path where one player's word moves the other player's money.

---

## What is built

| Area | State |
|------|-------|
| Auth, age gate, geofence, device fingerprinting | Built |
| Onboarding: email/phone verification, PSN link, skill tier, KYC | Built (verification and KYC document handling are mocked — see below) |
| Wallet: deposits, withdrawals, limits, statement | Built; intent → webhook-confirmed capture, with a mock provider by default |
| Double-entry ledger, append-only, with reconciliation | Built |
| Lobby with stake/mode/rules filters, quick match | Built |
| 1v1 match creation, escrow, match room, chat, ready state | Built |
| Dual result submission with auto-settle | Built |
| Screenshot evidence: immutable storage, hashing, duplicate detection, OCR | Built for PNG and JPEG (OCR engine is pluggable; the default is a development stub) |
| Trust score and trust-driven settlement policy | Built |
| Dispute queue and moderator resolution | Built |
| Anti-fraud: linked accounts, rate limits, laundering patterns | Built |
| Responsible play: deposit/loss limits, cool-off, self-exclusion | Built |
| Tournaments (single elimination) with escrowed entry fees | Built |
| Leaderboards by stake tier | Built |
| Admin dashboard, KYC review, fraud flags, settings | Built |
| Real-time: lobby, chat, ready state, countdown, disconnects, wallet | Built (Socket.io) |
| Pro subscription: lower rake, priority matchmaking | Built |
| Stripe integration | Built but **unverified against live Stripe** — no account was available. Signature verification and the capture flow are tested; the two REST calls are not. |
| React Native mobile app | **Not built.** The web client is mobile-first and works as a phone web app; a native shell is a separate piece of work. |

---

## Structure

```
apps/api        Express + TypeScript API, Socket.io gateway, background workers
apps/web        Next.js 14 App Router client, Tailwind, mobile-first dark UI
packages/shared Domain logic shared by both: settlement maths, trust scoring,
                result reconciliation, perceptual hashing, OCR parsing, types
```

Everything that decides money or trust lives in `packages/shared` as pure
functions, so it is unit-testable without a database and identical on both
sides of the wire.

## Running it

Requires Node 20+ and PostgreSQL 14+.

```bash
createuser escrow --pwprompt        # password: escrow
createdb escrow -O escrow

npm install
npm run build --workspace=packages/shared
npm run migrate --workspace=apps/api    # applies migrations in order, idempotent
npm run seed --workspace=apps/api       # optional demo players, matches, a cup

npm run dev:api    # http://localhost:4000
npm run dev:web    # http://localhost:3000
```

Configuration, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://escrow:escrow@localhost:5432/escrow` | Postgres connection |
| `JWT_SECRET` | a development constant | **Must** be set in any real deployment |
| `REDIS_URL` | unset | Matchmaking queue; falls back to an in-memory queue |
| `EVIDENCE_DIR` | `./.evidence` | Where screenshots are written by the local store |
| `OCR_ENGINE` | `sidecar` | `tesseract` to use real OCR (optional dependency) |
| `STRIPE_SECRET_KEY` | unset | Setting this **and** the webhook secret switches payments from mock to Stripe |
| `STRIPE_WEBHOOK_SECRET` | unset | Verifies webhook signatures; required alongside the secret key |
| `WORKERS` | on | `off` to run the API without background jobs |
| `WEB_ORIGIN` | `*` | CORS origin for the web client |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | API base URL for the web client |

## Tests

```bash
createdb escrow_test -O escrow
npm test
```

146 tests across 11 suites, run against a real PostgreSQL database rather than a
stub — the money paths are only meaningful if the transactions, row locks and
constraints are real. Migrations are applied once before the suite; tables are
truncated between cases.

Every test that moves money finishes by asserting `reconcileWallets()` returns
an empty array: the cached wallet balances and the ledger agree exactly.

---

## How the money works

### Double-entry ledger

`wallets` is a cache. The truth is `ledger_entries`, where every row is a
transfer between two named accounts:

```
deposit          external:settlement  →  user:<id>:available
stake            user:<id>:available  →  escrow:match:<id>
payout           escrow:match:<id>    →  user:<winner>:available
rake             escrow:match:<id>    →  platform:revenue
refund           escrow:match:<id>    →  user:<id>:available
withdrawal       user:<id>:available  →  external:settlement
```

There is no way to express a one-sided entry, so the books cannot be written out
of balance — summing every account always yields zero. `UPDATE` and `DELETE` on
the ledger raise an exception at the database level, so history is append-only
for the application and for anyone with a psql prompt.

Wallet balances are updated in the same transaction as the ledger posting, and
`reconcileWallets()` compares the two. The admin dashboard surfaces any
disagreement; it should always be empty.

### Deposits

A deposit is two steps, always: an intent is recorded, the provider captures the
money, and only then is the ledger credited. Crediting on the client's word is
how a platform gets drained, so the wallet does not move until the provider's
webhook arrives.

The mock provider collapses both steps into one call, so development and tests
behave as if payment were instant. Stripe activates on configuration — if
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are both present it is used,
otherwise the mock is, which makes it impossible to deploy "live payments" with
no credentials behind them.

Three properties carry the weight, and each is tested:

- **Signatures.** Webhooks are parsed as raw bytes, ahead of the JSON parser,
  because the signature covers exactly what was sent. Verification is
  constant-time and rejects an old timestamp, so a captured request cannot be
  replayed later. An unsigned or forged request is a 400.
- **Idempotency.** A webhook can be delivered any number of times. Only the call
  that moves the intent out of `pending` credits the ledger, so a redelivery —
  or a second, differently-identified event naming the same payment — credits
  once.
- **Amount agreement.** A provider reporting a different amount than the intent
  recorded is not a payment to credit; it raises a fraud flag and nothing moves.

Withdrawals debit first and then ask the provider to move the money, so a slow
payout cannot be spent twice while it is in flight. If the provider refuses, the
debit is reversed.

### Settlement

- Rake is **10%** of the pool by default, **7%** if either player subscribes to
  Pro. Both are runtime settings, not constants in code. The discount is read
  from the live subscription period, not a cached tier flag, so a lapsed
  subscription stops earning it immediately.
- The fee is rounded to the nearest cent and the winner takes the remainder, so
  `pool == fee + payout` exactly, at any stake and any rake.
- A **draw voids the match**: both stakes are returned in full and no rake is
  taken. The house does not profit from a game that produced no result.
- Both stakes are locked in escrow the moment the second player joins, and stay
  there through reporting, disputes and moderation.

---

## The verification layer

This is where the product's risk actually sits, so it is built out rather than
sketched.

**Evidence is immutable.** A screenshot is hashed (SHA-256) and written to
content-addressed storage on upload. A database trigger rejects any update that
would change the bytes, the storage key, the match or the uploader; only the
analysis columns can change afterwards.

**Duplicate detection runs in two passes.** An identical re-upload is caught by
the content hash. A crop, a rescale or a re-encode of last week's win is caught
by a 64-bit dHash — a perceptual hash that survives the transformations a
screenshot goes through, with a Hamming distance threshold of 6. PNG and JPEG
are both decoded (a PS5 share export is JPEG), and the format is sniffed from
the magic bytes rather than the declared content type, so a mislabelled upload
cannot dodge the check.

**OCR checks the story.** The worker reads the post-match summary, extracts the
scoreline and both gamertags, and compares them to what the player typed. A
scoreline that contradicts the report, or gamertags belonging to two other
players, flags the screenshot and blocks auto-settlement even when the two
players' typed reports agree.

The OCR engine is behind a two-method interface. The default is a development
stub that reads a text sidecar, so the entire pipeline — parse, compare, flag,
hold — is exercised end to end in CI without shipping a language model.
`OCR_ENGINE=tesseract` swaps in real recognition. The parsing and comparison
logic, which is what actually decides anything, is engine-independent and
directly tested against realistic OCR noise.

**Trust decides how much evidence is needed.** Each player has a score from 0 to
100, recomputed from the `trust_events` log rather than nudged, so it is always
reproducible and always explainable on their profile. The *lower* of the two
players' scores governs the match:

| Band | Policy |
|---|---|
| 75+ | Auto-settle on agreement, no screenshot required |
| 40–74 | Both screenshots required before escrow releases |
| under 40 | Both screenshots required, and a moderator rules regardless |

**Nothing settles on one player's word.** If the opponent never reports, the
reporting window closes and the match goes to the moderation queue with the one
report, the screenshots and the chat log attached — it is not an automatic
forfeit. A player who wants out can forfeit deliberately, which pays their
opponent and costs them less trust than a dispute they lose.

---

## Anti-fraud

- **Self-matching.** Two accounts sharing a *device fingerprint* or a *payment
  instrument* cannot play each other, and the blocked attempt is recorded. Two
  accounts sharing only an *IP address* are allowed to play but flagged for
  review — flatmates, a family console and carrier-grade NAT all look like that,
  and blocking them would break a real use case to stop a fraud they may not be
  committing.
- **Geofencing** runs against both the request's IP country and the verified KYC
  address, because an IP check alone is one VPN away from useless. The blocked
  region list is a database table, editable by an admin without a deploy.
- **Age gate** at 18, with per-jurisdiction minimums (19 and 21 entries are
  seeded) applied on top.
- **Money movement** is rate-limited per account and capped per rolling 24 hours,
  and a deposit-then-withdraw with no matches played in between raises a flag.
- **Responsible play** limits ratchet one way: a player can tighten a deposit or
  loss limit instantly, but not raise or remove one mid-session. Self-exclusion
  cannot be lifted early by anyone. Session-time reminders are keyed to the
  player rather than the connection, so a second tab does not double them and
  closing one does not reset the clock.

---

## Real-time

Domain services publish to an internal bus; the Socket.io gateway is one
subscriber. That keeps every service testable without opening a socket, and
means a websocket outage degrades the product (no live updates) instead of
breaking settlement. Sockets carry lobby updates, match chat, ready state,
countdowns, opponent-disconnect detection, wallet balance and notifications —
**nothing that moves money goes over a socket.**

---

## API

`/auth/*`, `/config` and `/health` are open. Everything else needs
`Authorization: Bearer <token>`. The acting identity always comes from the
token, never from the request body.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | Session, with age and region checks at signup |
| GET | `/me` | Current user, wallet and KYC state |
| POST | `/me/psn`, `/me/skill-tier`, `/me/verify-email`, `/me/verify-phone` | Onboarding |
| POST | `/me/kyc` | Submit identity documents for review |
| POST | `/me/responsible-play`, `/me/cool-off`, `/me/self-exclude` | Player-set limits |
| GET | `/me/trust`, `/me/notifications` | Trust event log, inbox |
| GET/POST | `/wallet`, `/wallet/deposit`, `/wallet/withdraw`, `/wallet/history` | Money |
| GET/POST/DELETE | `/subscription` | Goal 27 Pro: status, subscribe, cancel at period end |
| POST | `/webhooks/payments` | Provider callbacks — signature-authenticated, no session |
| GET | `/matches` | Lobby, filtered by stake, mode and half length |
| POST | `/matches` | Create a match — escrows the creator's stake |
| POST | `/matches/quick` | Join the matchmaking queue, or get paired |
| POST | `/matches/:id/join` | Join — escrows the opponent's stake |
| POST | `/matches/:id/ready`, `/chat`, `/forfeit`, `/cancel` | Match room |
| POST | `/matches/:id/screenshots` | Upload evidence (base64, ≤8 MB) |
| POST | `/matches/:id/result` | Report a score; auto-settles when both agree |
| GET | `/matches/leaderboard?stakeCents=` | Leaderboard for one stake tier |
| POST | `/disputes` | Raise a dispute (participants only) |
| GET | `/disputes`, `/disputes/:id` | Moderation queue and case file |
| POST | `/disputes/:id/resolve` | Moderator ruling — the only contested release |
| GET | `/evidence/:screenshotId` | Screenshot bytes, participants and staff only |
| GET/POST | `/tournaments/*` | Brackets, entry, admin start/cancel |
| GET/POST | `/admin/*` | Dashboard, KYC review, bans, strikes, settings, regions |

---

## Data model

`users`, `wallets`, `ledger_transactions` + `ledger_entries`, `matches`,
`match_results`, `screenshots`, `ocr_jobs`, `disputes`, `trust_events`,
`kyc_records`, `notifications`, `chat_messages`, `tournaments`,
`tournament_entries`, `tournament_matches`, `device_fingerprints`,
`payment_methods`, `payment_intents`, `blocked_regions`, `fraud_flags`,
`admin_actions`, `platform_settings`, `subscriptions`, `payment_events`.

Escrow state is a column on `matches` rather than a separate table: escrow is
one-to-one with a match, and the ledger already holds the amounts.

Migrations live in `apps/api/src/db/migrations` and are applied in filename
order, each in its own transaction, tracked in `schema_migrations`.

> The first migration **drops** the Phase 1 scaffold tables. Phase 1 was never
> deployed and held no real money, and its single mutable balance column has no
> meaningful translation into a double-entry ledger.

---

## Before going live

This is a working MVP, not a launch-ready product. The gaps that matter:

1. **The Stripe integration has never spoken to Stripe.** The flow around it is
   tested — signatures, idempotency, amount checks, reversal — but the two REST
   calls (`/payment_intents`, `/payouts`) were written against the API docs and
   have not been exercised against a real account. Run them against test keys
   before trusting them. Stripe **Connect** specifically (onboarding payees,
   split payouts) is not built at all; payouts here are plain transfers.
2. **Email, SMS and KYC document handling are stubs.** The endpoints set the
   flags the rest of the platform reads, so swapping in real providers touches
   only those handlers.
3. **OCR needs a real engine.** The default is a development stub that reads a
   text sidecar. `OCR_ENGINE=tesseract` swaps in real recognition, and the
   parsing and comparison logic — which is what actually decides anything — is
   engine-independent and already tested.
4. **Duplicate screenshot search is a linear scan** over recent hashes. That is
   fine at MVP volume and will not be at scale; it wants a BK-tree or a vector
   index.
5. **Legal and compliance.** Real-money skill competitions are regulated as
   gambling or money transmission in many jurisdictions. The seeded blocked
   region list is a starting point for a compliance review, **not legal advice**.
   Do not accept real deposits until licensing, AML/KYC obligations and
   chargeback handling are confirmed for every jurisdiction you operate in.
6. **`JWT_SECRET` must be set**, evidence storage should move to S3 with
   server-side encryption, and the API should sit behind a rate limiter and a
   WAF before it sees real money.
