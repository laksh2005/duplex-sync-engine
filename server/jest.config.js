module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: ['services/**/*.js', 'utils/**/*.js', 'controllers/**/*.js'],
  coveragePathIgnorePatterns: ['/node_modules/'],
  testTimeout: 20000,
  clearMocks: true
}
