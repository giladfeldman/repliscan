export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  moduleNameMapper: { '^(\.{1,2}/.*)\.js$': '$1' },
  // tests may share helper modules that live under tests/ (outside the build's rootDir=src)
  transform: { '^.+\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.test.json' }] },
};
