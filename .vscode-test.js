const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig([
  {
    label: 'unicode-keyboard-tests',
    files: 'out/test/keyboard/*.keyboard.js',
    version: 'stable',
    installExtensions: ['haskell.language-haskell'],
    mocha: { timeout: 10000 },
  },
  {
    label: 'unicode-input-tests',
    files: 'out/test/suite/unicodeInput.test.js',
    version: 'stable',
    mocha: { timeout: 10000 },
  },
  {
    label: 'integration-tests',
    files: 'out/test/**/*.test.js',
    version: 'stable',
    workspaceFolder: './test-workspace',
    installExtensions: ['haskell.language-haskell'],
    mocha: {
      timeout: 120 * 1000, // 2 minute timeout
    },
  },
  // you can specify additional test configurations, too
]);
