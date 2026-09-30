/**
 * Configuration that only bites in production.
 *
 * The development JWT secret is committed to a public repository, so a
 * deployment that forgets to set its own would let anyone who reads the repo
 * mint a valid session token for any account. These tests exist because that
 * failure is silent: everything works, and every wallet is open.
 */
describe('production configuration', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    jest.resetModules();
  });

  function loadJwt(env: Record<string, string | undefined>) {
    jest.resetModules();
    process.env = { ...original, ...env };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return () => require('../src/common/jwt');
  }

  it('refuses to start in production without a JWT secret', () => {
    expect(loadJwt({ NODE_ENV: 'production', JWT_SECRET: undefined })).toThrow(
      /JWT_SECRET is not set/,
    );
  });

  it('refuses a secret short enough to guess', () => {
    expect(loadJwt({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toThrow(/too short/);
  });

  it('starts with a real secret, and the token round-trips', () => {
    const jwt = loadJwt({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(48) })();
    const token = jwt.signToken('11111111-1111-1111-1111-111111111111');
    expect(jwt.verifyToken(token).sub).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('leaves development alone — the default is fine off a laptop', () => {
    const jwt = loadJwt({ NODE_ENV: 'development', JWT_SECRET: undefined })();
    expect(jwt.verifyToken(jwt.signToken('abc')).sub).toBe('abc');
  });
});
