# Goal 27 — context for whoever picks this up

Escrow-backed 1v1 money matches on EA Sports FC for PS5. Two players stake,
play on their own consoles, report the score, and the winner is paid minus one
escrow fee.

Read this before changing anything under `apps/api/src/modules/wallet`,
`.../settlement`, `.../results` or `packages/shared/src/settlement.ts`. The
rules below are not style preferences — each one exists because breaking it
loses somebody's money or lets somebody steal it.

---

## Invariants. Do not break these.

**1. Escrow releases on agreement or a moderator ruling. Nothing else.**
Not on one player's report, not on a timeout, not on a socket message, not on
an admin's convenience. If you are adding a code path that moves money out of
`escrow:match:<id>`, it goes through `settleMatch()` in
`modules/settlement/settlement.service.ts` — the single release path — or it is
wrong.

**2. The ledger is append-only and balanced by construction.**
Every movement is a transfer between two named accounts (`ledger_entries` has
`debit_account` and `credit_account`). There is no way to write a one-sided
entry, so all accounts always sum to zero. `UPDATE` and `DELETE` on the ledger
raise a database exception — deliberately, including from psql. Never add a
"correction" that edits history; post a compensating transaction instead.

**3. Wallets are a cache; the ledger is the truth.**
`wallets.available_cents` / `locked_cents` are materialised for speed. They are
updated in the *same database transaction* as the ledger posting they pair
with, never separately. `reconcileWallets()` asserts the two agree, and every
test that moves money ends by asserting it returns `[]`. If you add a money
path, add that assertion to its test. It is the check that catches what your
own expectations miss.

**4. Money never moves over a websocket.**
Sockets carry lobby updates, chat, ready state, countdowns and notifications.
Anything that moves money goes over HTTP, where it is validated and
transactional. Same rule applies to any future Discord bot or third-party
integration.

**5. The acting identity comes from the auth token, never the request body.**
A client cannot deposit into, stake from, or report for another account by
editing a payload.

**6. Screenshots are immutable evidence.**
Hashed on upload, content-addressed storage, and a database trigger rejects any
update to the bytes, storage key, match or uploader. Only the analysis columns
(OCR fields, verdict) may change afterwards.

**7. Refunds are never charged a fee.**
Draws, voids, replays, moderator refunds, cancelling an unjoined match, and a
withdrawal the provider refused all return the full amount. The platform earns
when it settles a contest or moves money out — never when a match fails to
happen. See the exemption tests in `apps/api/test/escrow-fee.test.ts`.

---

## The fee model

One escrow fee, one rate, resolved in one place: `apps/api/src/common/fees.ts`,
backed by the `escrow_fee_bps` / `pro_escrow_fee_bps` platform settings.

| Charged | Not charged |
|---|---|
| Winning payout (from the pool) | Deposits |
| Tournament prize (from the pool) | Draws, voids, replays, refunds |
| Withdrawal (from the amount) | Cancelling an unjoined match |

Defaults 10%, 7% for Goal 27 Pro subscribers. On a withdrawal the fee comes
**out of** the requested amount, never on top — asking to withdraw $50 always
removes exactly $50 from the wallet. Quoting it the other way round would let a
withdrawal exceed the balance that authorised it.

The rate is frozen onto a match or tournament row (`escrow_fee_bps`) at
creation, so changing the platform rate never re-prices a contest already under
way. The Pro discount is read from the **live subscription period**, not the
cached `users.subscription_tier` flag, so a lapsed subscription stops earning it
immediately rather than at the next renewal sweep.

**Known tension:** charging on both settlement and withdrawal takes roughly 19%
of a pool across a full deposit-play-withdraw cycle. That was a deliberate
product decision, not an oversight. Splitting the rate in two (settlement vs
withdrawal) means splitting `escrowFeeBpsFor` — a contained change.

## Verification, and why it is shaped this way

There is **no live score feed**. Sony exposes no public PSN API for game state,
and EA exposes no public FC match API. Everything below exists because the
score can only come from the players themselves.

- **Duplicate detection runs twice**: SHA-256 catches an identical re-upload,
  a 64-bit dHash catches a crop, rescale or re-encode of an old win. PNG and
  JPEG are both decoded, and the format is sniffed from magic bytes rather than
  the declared content type.
- **OCR checks the story**: reads the scoreline and both gamertags and compares
  them to what the player typed. A contradicted or recycled screenshot blocks
  auto-settlement *even when both players agree*.
- **Trust decides how much evidence is needed** (`packages/shared/src/trust.ts`).
  The *lower* of the two scores governs: 75+ auto-settles with no screenshot,
  40–74 needs both, under 40 goes to a moderator regardless. The score is
  recomputed from the `trust_events` log, never nudged, so it is always
  reproducible.
- **A silent opponent escalates, it does not forfeit.** The reporting deadline
  sends the match to the moderation queue with the one report, the screenshots
  and the chat log — it never hands the reporter an automatic win.

### A bug worth not reintroducing

`held_for_review` is a *waiting* state, not an outcome. Two players agreeing
with no screenshots yet returns it — and originally nothing ever looked again,
so the escrow was stuck forever with no automatic path out. `finaliseIfPossible()`
in `modules/results/results.service.ts` is deliberately re-runnable and is
called both on every report *and* after each screenshot is analysed. The
deadline sweep also escalates a stuck two-report match rather than skipping it.
If you touch that path, keep both callers.

## Anti-fraud

- **Shared device or payment instrument blocks a match; a shared IP does not.**
  Flatmates, an office and carrier-grade NAT all look identical to collusion
  from an IP alone. Shared address is flagged for review at join time only —
  and deliberately *not* flagged at signup, where it produced one flag per pair
  and grew quadratically.
- Geofence checks both the request IP country and the verified KYC address; an
  IP check alone is one VPN away from useless.
- Age gate with per-jurisdiction minimums on top of the platform default.
- Responsible-play limits ratchet one way — tighten instantly, never loosen
  mid-session. Self-exclusion cannot be lifted early by anyone.

## Layout

```
packages/shared   Pure domain logic: settlement maths, trust scoring, result
                  reconciliation, perceptual hashing, OCR parsing, types.
                  No I/O — unit-testable without a database, identical on both
                  sides of the wire.
apps/api          Express + Socket.io + background workers.
  common/         Errors, settings, fees, auth, geo.
  db/repos/       All SQL. Nothing else in the codebase writes queries.
  db/migrations/  Applied in filename order, tracked in schema_migrations.
  modules/        One directory per domain area; *.service.ts holds the logic,
                  *.routes.ts is validation + HTTP only.
  realtime/       Internal bus; the Socket.io gateway is one subscriber.
  payments/       Provider seam — mock by default, Stripe on configuration.
  queue/          OCR worker, deadline sweep, subscription renewals.
apps/web          Next.js 14 App Router, Tailwind, mobile-first dark UI.
```

Services publish to `realtime/bus.ts`; the gateway subscribes. Keep it that
way — it is what makes every service testable without opening a socket, and it
means a websocket outage degrades the product instead of breaking settlement.

## Running and testing

```bash
docker run -d -p 5432:5432 -e POSTGRES_USER=escrow \
  -e POSTGRES_PASSWORD=escrow -e POSTGRES_DB=escrow postgres:16
npm install
npm run build --workspace=packages/shared   # apps import its build output
npm run migrate && npm run seed
npm run dev:api      # :4000   (PORT= to change)
npm run dev:web      # :3000   (NEXT_PUBLIC_API_URL must match the API port)
```

Demo accounts: `striker@` / `keeper@` / `admin@goal27.test`, password
`goal27-demo-password`.

```bash
npm test        # 169 tests, creates its own escrow_test database
npm run typecheck
```

Tests run against a real PostgreSQL, not a stub — the money paths are only
meaningful if the transactions, row locks and constraints are real. CI runs the
same commands on every push.

## Traps

- **`packages/shared` must be built before anything else typechecks.** The apps
  import its `dist` output, not its source.
- **`NEXT_PUBLIC_API_URL` is read at build time.** Change the API port without
  it and you get a page that renders but cannot log in.
- **The realtime bus is an in-process EventEmitter.** Fine on one API instance.
  Run two and a player connected to instance A never receives events published
  on instance B — silent, and it looks like flaky sockets. Needs the Socket.io
  Redis adapter before scaling out.
- **Screenshots are on local disk** (`LocalEvidenceStore`). Container
  filesystems are ephemeral; a redeploy destroys evidence a dispute depends on.
  The `EvidenceStore` interface is two methods and S3 drops straight in. This is
  a hard blocker for any real deployment.
- **The OCR engine is a development stub** that reads a text sidecar, so the
  pipeline runs in CI without a language model. `OCR_ENGINE=tesseract` swaps in
  real recognition. The parsing and comparison logic is engine-independent and
  already tested.
- **Stripe has never spoken to Stripe.** Signatures, idempotency, amount checks
  and reversal are tested; the two REST calls were written against the docs and
  need exercising against test keys. Stripe *Connect* is not built at all.

## Not built, deliberately

React Native app (web is mobile-first and works as a phone web app), live
payments (mock provider behind a real payment-intent record), real email/SMS/KYC
providers (stubs that set the flags the platform reads), account deletion
(required by Apple and GDPR — non-trivial because the ledger is append-only, so
it means anonymising the user while preserving the financial record).

## Before real money moves

Paid entry-fee skill contests are regulated as gambling or money transmission in
many jurisdictions. The seeded blocked-region list is a starting point for a
compliance review, **not legal advice**. Licensing gates both hosting and any
App Store submission. `JWT_SECRET` must be set. Evidence storage must move to S3.
