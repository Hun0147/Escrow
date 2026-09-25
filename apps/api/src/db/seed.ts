import bcrypt from 'bcryptjs';
import { pool } from './pool';
import { runMigrations } from './migrate';
import { findUserById, insertUser, updateUser } from './repos/users.repo';
import { createWallet } from './repos/ledger.repo';
import { withTransaction } from './transaction';
import { creditDeposit } from '../modules/wallet/money.service';
import { createMatch, joinMatch } from '../modules/matches/matches.service';
import { submitResult } from '../modules/results/results.service';
import { createTournament } from '../modules/tournaments/tournaments.service';

/**
 * Development seed: a handful of players, a couple of live matches and one
 * open tournament, so the lobby, wallet and admin screens have something real
 * to show. Safe to re-run — it skips if the demo accounts already exist.
 */
const PASSWORD = 'goal27-demo-password';

async function seed() {
  await runMigrations(() => undefined);

  const existing = await pool.query("SELECT 1 FROM users WHERE email = 'striker@goal27.test'");
  if (existing.rowCount) {
    console.log('Seed data already present.');
    return;
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const players = [];

  for (const [handle, psnId, trust] of [
    ['striker', 'Striker_Sam', 92],
    ['keeper', 'KeeperKate', 88],
    ['winger', 'WingerWes', 64],
    ['sub', 'SubbedOn', 35],
  ] as const) {
    const user = await insertUser({
      handle,
      email: `${handle}@goal27.test`,
      passwordHash,
      dateOfBirth: '1997-05-05',
      countryCode: 'GB',
      psnId,
    });
    await createWallet(user.id);
    await updateUser(user.id, { emailVerified: true, kycStatus: 'approved', trustScore: trust });
    await withTransaction((client) => creditDeposit(client, user.id, 50_000, 'demo seed'));
    players.push(findUserById(user.id));
  }

  const [striker, keeper, winger] = await Promise.all(players);

  const admin = await insertUser({
    handle: 'refbot',
    email: 'admin@goal27.test',
    passwordHash,
    dateOfBirth: '1990-01-01',
    countryCode: 'GB',
    psnId: 'RefBot27',
    role: 'admin',
  });
  await createWallet(admin.id);
  await updateUser(admin.id, { emailVerified: true, kycStatus: 'approved' });

  // A settled match, so leaderboards and statements are not empty.
  const settled = await createMatch(striker!, { gameMode: 'ultimate_team', stakeCents: 2500 });
  await joinMatch(keeper!, settled.id);
  await submitResult(striker!, { matchId: settled.id, selfScore: 3, opponentScore: 1 });
  await submitResult(keeper!, { matchId: settled.id, selfScore: 1, opponentScore: 3 });

  // Two open matches waiting in the lobby.
  await createMatch(winger!, { gameMode: 'seasons', stakeCents: 1000 });
  await createMatch(keeper!, { gameMode: 'pro_clubs', stakeCents: 5000, rules: { halfLengthMinutes: 8 } });

  await createTournament({
    name: 'Friday Night Cup',
    gameMode: 'ultimate_team',
    entryFeeCents: 1000,
    maxEntrants: 8,
    sponsorName: 'Boot Room Energy',
  });

  console.log('Seeded. Sign in with striker@goal27.test / keeper@goal27.test / admin@goal27.test');
  console.log(`Password for every demo account: ${PASSWORD}`);
}

seed()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
