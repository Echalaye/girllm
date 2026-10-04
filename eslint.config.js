// ESLint flat config: type-aware TypeScript rules for src/scripts/tests,
// browser globals for the dependency-free front-end in public/.
// Formatting is Prettier's job (eslint-config-prettier disables style rules).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'data/', 'models/', 'public/*.d.ts'] },

  js.configs.recommended,

  // ---- TypeScript (server, scripts, tests) ----------------------------------
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.node,
    },
    rules: {
      // Promises must be awaited or explicitly voided: unhandled rejections crash Node.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Template literals with numbers are fine and common in log messages.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // `!` after a length/has check is clearer than redundant guards here.
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Tests: relax rules that fight with mocks and assertions.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',
    },
  },

  // Fastify route handlers must be async (they return the response) even
  // when they don't await anything.
  { files: ['src/http/**/*.ts'], rules: { '@typescript-eslint/require-await': 'off' } },

  // CLI scripts print to the console by design.
  { files: ['scripts/**/*.ts', 'src/index.ts'], rules: { 'no-console': 'off' } },

  // ---- Browser front-end (plain ES modules) --------------------------------
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'module' },
    rules: { eqeqeq: ['error', 'always'] },
  },

  // The microphone capture runs in the audio rendering thread.
  {
    files: ['public/**/*.worklet.js'],
    languageOptions: {
      globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly', sampleRate: 'readonly' },
    },
  },

  // Config files run in Node.
  { files: ['*.config.js'], languageOptions: { globals: globals.node } },

  prettier,
);
