module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  // Money tests share one Postgres database and truncate between cases, so
  // they must not run concurrently.
  maxWorkers: 1,
  testTimeout: 30000,
};
