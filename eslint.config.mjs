// VitalPulse ESLint config (flat config, ESLint 9+).
// Doubles as the "ESLint security plugins" leg of Part 3.2's SAST requirement,
// alongside Semgrep in CI (see .github/workflows/ci-cd.yml).
import js from '@eslint/js';
import globals from 'globals';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/lib/**',
      '**/coverage/**',
      'vitalpulse_app/public/**',
      // Master Plan reference/draft companion files, not live code (see docs/).
      'vitalpulse_app/docs/**',
      'stitch_lifestream_cameroon_coordination_system/**',
      '.opencode/**',
    ],
  },
  js.configs.recommended,

  // Frontend: vanilla JS, ES modules, browser runtime.
  {
    files: ['vitalpulse_app/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      'no-unused-vars': 'warn',
    },
  },
  // Frontend one-off build/text-processing scripts (CommonJS, Node).
  {
    files: ['vitalpulse_app/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { security },
    rules: { ...security.configs.recommended.rules },
  },
  // Frontend build tooling configs (Vite/Tailwind/PostCSS) — ESM with a Node-tooling runtime.
  {
    files: ['vitalpulse_app/*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // main.js uses a deliberate monkey-patch pattern (const _orig = fn; fn = async function(){...})
    // to layer behavior onto loadHospitalDashboard/loadHospitalSettings — not a bug, so no-func-assign
    // doesn't apply here. no-useless-assignment fires on `let x = ''` followed by an exhaustive
    // if/else-if/else that always reassigns before read — harmless defensive style, not dead logic.
    files: ['vitalpulse_app/src/main.js'],
    rules: {
      'no-func-assign': 'off',
      'no-useless-assignment': 'off',
    },
  },

  // Cloud Functions + operator scripts: TypeScript, Node.
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ['functions/src/**/*.ts', 'scripts/**/*.ts'],
  })),
  {
    files: ['functions/src/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
  {
    // Authz-critical: no relaxing these two rules without Security Lead review (Policy 8).
    files: ['functions/src/grantRole.ts', 'functions/src/revokeRole.ts', 'functions/src/roles.ts'],
    rules: {
      'security/detect-object-injection': 'warn',
    },
  },

  // k6 load-test script: k6 injects these globals into the sandboxed JS runtime it
  // executes scripts in (not Node, not a browser) — see k6-stress-tests.js's header.
  {
    files: ['k6-stress-tests.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' },
    },
  },

  // Test files and vitest/vite configs: Node globals, relax test-only patterns.
  {
    files: ['**/*.test.js', '**/*.test.ts', 'firestore.rules.test.js', '**/vitest.*.config.*', 'vite.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-object-injection': 'off',
    },
  },
];
