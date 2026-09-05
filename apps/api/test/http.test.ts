import request from 'supertest';
import { createApp } from '../src/app';
import { makeUser } from './factories';
import { signToken } from '../src/common/jwt';
import { reconcileWallets } from '../src/db/repos/ledger.repo';

const app = createApp();

const bearer = (userId: string) => `Bearer ${signToken(userId)}`;

describe('HTTP surface', () => {
  it('registers, logs in and returns a usable session', async () => {
    const register = await request(app)
      .post('/auth/register')
      .send({
        handle: 'httpuser',
        email: 'http@example.test',
        password: 'a-long-enough-password',
        dateOfBirth: '1994-02-02',
        countryCode: 'GB',
        psnId: 'HttpUser_PSN',
      });

    expect(register.status).toBe(201);
    expect(register.body.token).toBeTruthy();
    expect(register.body.user.email).toBe('http@example.test');
    expect(register.body.user).not.toHaveProperty('passwordHash');
    expect(register.body.wallet.availableCents).toBe(0);

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'http@example.test', password: 'a-long-enough-password' });
    expect(login.status).toBe(200);

    const wrong = await request(app)
      .post('/auth/login')
      .send({ email: 'http@example.test', password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('unauthorized');
  });

  it('rejects a weak password and a malformed date of birth with field detail', async () => {
    const response = await request(app).post('/auth/register').send({
      handle: 'shorty',
      email: 'shorty@example.test',
      password: 'short',
      dateOfBirth: '02/02/1994',
      countryCode: 'GB',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_body');
    expect(response.body.error.details.fieldErrors).toHaveProperty('password');
    expect(response.body.error.details.fieldErrors).toHaveProperty('dateOfBirth');
  });

  it('locks every non-auth route behind a token', async () => {
    for (const [method, path] of [
      ['get', '/me'],
      ['get', '/wallet'],
      ['get', '/matches'],
      ['post', '/matches'],
      ['get', '/admin/dashboard'],
    ] as const) {
      const response = await (request(app) as never as Record<string, (p: string) => request.Test>)[method](path);
      expect(response.status).toBe(401);
    }
  });

  it('publishes the lobby configuration without a token', async () => {
    const response = await request(app).get('/config');
    expect(response.status).toBe(200);
    expect(response.body.stakeTiersCents).toEqual([500, 1000, 2500, 5000, 10000]);
    expect(response.body.gameModes).toContain('ultimate_team');
  });

  it('runs a whole match over HTTP, from deposit to payout', async () => {
    const creator = await makeUser({ trustScore: 90, handle: 'http_creator', psnId: 'Http_Creator' });
    const opponent = await makeUser({ trustScore: 90, handle: 'http_opponent', psnId: 'Http_Opponent' });

    for (const player of [creator, opponent]) {
      const deposit = await request(app)
        .post('/wallet/deposit')
        .set('Authorization', bearer(player.id))
        .send({ amountCents: 5000 });
      expect(deposit.status).toBe(200);
      // The mock provider captures instantly, so the balance is already there.
      expect(deposit.body.status).toBe('captured');
      expect(deposit.body.wallet.availableCents).toBe(5000);
    }

    const created = await request(app)
      .post('/matches')
      .set('Authorization', bearer(creator.id))
      .send({ gameMode: 'ultimate_team', stakeCents: 2500, rules: { halfLengthMinutes: 6 } });
    expect(created.status).toBe(201);
    const matchId = created.body.match.id;

    // The opponent sees it in the lobby; the creator does not see their own.
    const lobby = await request(app).get('/matches').set('Authorization', bearer(opponent.id));
    expect(lobby.body.matches.map((entry: any) => entry.match.id)).toContain(matchId);
    const ownLobby = await request(app).get('/matches').set('Authorization', bearer(creator.id));
    expect(ownLobby.body.matches.map((entry: any) => entry.match.id)).not.toContain(matchId);

    const join = await request(app)
      .post(`/matches/${matchId}/join`)
      .set('Authorization', bearer(opponent.id));
    expect(join.status).toBe(200);
    expect(join.body.match.status).toBe('escrowed');

    for (const player of [creator, opponent]) {
      await request(app)
        .post(`/matches/${matchId}/ready`)
        .set('Authorization', bearer(player.id))
        .send({ ready: true });
    }

    await request(app)
      .post(`/matches/${matchId}/chat`)
      .set('Authorization', bearer(creator.id))
      .send({ body: 'good luck' });

    const first = await request(app)
      .post(`/matches/${matchId}/result`)
      .set('Authorization', bearer(creator.id))
      .send({ selfScore: 2, opponentScore: 0 });
    expect(first.body.status).toBe('awaiting_opponent');

    const second = await request(app)
      .post(`/matches/${matchId}/result`)
      .set('Authorization', bearer(opponent.id))
      .send({ selfScore: 0, opponentScore: 2 });
    expect(second.body.status).toBe('settled');

    const wallet = await request(app).get('/wallet').set('Authorization', bearer(creator.id));
    expect(wallet.body.wallet.availableCents).toBe(2500 + 4500);

    const history = await request(app).get('/wallet/history').set('Authorization', bearer(creator.id));
    expect(history.body.entries.map((e: any) => e.type)).toEqual(
      expect.arrayContaining(['deposit', 'escrow_lock', 'escrow_payout']),
    );

    const detail = await request(app).get(`/matches/${matchId}`).set('Authorization', bearer(creator.id));
    expect(detail.body.match.winnerId).toBe(creator.id);
    expect(detail.body.results).toHaveLength(2);

    expect(await reconcileWallets()).toEqual([]);
  });

  it('keeps the moderation queue away from players', async () => {
    const player = await makeUser();
    const moderator = await makeUser({ role: 'moderator' });

    const denied = await request(app).get('/disputes').set('Authorization', bearer(player.id));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('insufficient_role');

    const allowed = await request(app).get('/disputes').set('Authorization', bearer(moderator.id));
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body.disputes)).toBe(true);
  });

  it('keeps admin-only actions away from moderators', async () => {
    const moderator = await makeUser({ role: 'moderator' });
    const response = await request(app)
      .post('/admin/settings')
      .set('Authorization', bearer(moderator.id))
      .send({ key: 'rake_bps', value: 0 });
    expect(response.status).toBe(403);
  });

  it('reports a healthy ledger on the admin dashboard', async () => {
    const admin = await makeUser({ role: 'admin' });
    const response = await request(app).get('/admin/dashboard').set('Authorization', bearer(admin.id));
    expect(response.status).toBe(200);
    expect(response.body.reconciliationBreaks).toEqual([]);
    expect(response.body.settings.rake_bps).toBe(1000);
    expect(response.body).toHaveProperty('escrowHeldCents');
  });

  it('returns a clean 404 for an unknown route', async () => {
    const response = await request(app).get('/nope');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('pairs two players through the quick-match queue', async () => {
    const a = await makeUser({ balanceCents: 5000, handle: 'quick_a', psnId: 'Quick_A' });
    const b = await makeUser({ balanceCents: 5000, handle: 'quick_b', psnId: 'Quick_B' });

    const queued = await request(app)
      .post('/matches/quick')
      .set('Authorization', bearer(a.id))
      .send({ gameMode: 'ultimate_team', stakeCents: 1000 });
    expect(queued.body.status).toBe('queued');

    const matched = await request(app)
      .post('/matches/quick')
      .set('Authorization', bearer(b.id))
      .send({ gameMode: 'ultimate_team', stakeCents: 1000 });
    expect(matched.body.status).toBe('matched');
    expect(matched.body.match.creatorId).toBe(a.id);
    expect(matched.body.match.opponentId).toBe(b.id);
    expect(await reconcileWallets()).toEqual([]);
  });
});
