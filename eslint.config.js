// ESLint flat config (house-style pre-upload check for Node.js). Run with: npm run lint
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: globals.browser },
  },
  {
    rules: {
      // Empty catch blocks are only used where a failure is expected and harmless (localStorage
      // in private windows, a file that's already gone).
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
