// ESLint (flat config) for KC Snap. Run with: npm run lint
//
// The app is a single inline <script> in index.html, so tests/lint.mjs
// pulls it out and hands it to ESLint on stdin under the
// virtual name below. Nothing is installed into the project: the lint script
// runs a pinned ESLint through npx.

const bugRules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-redeclare': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-fallthrough': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-async-promise-executor': 'error',
  'no-loss-of-precision': 'error',
  'no-sparse-arrays': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'getter-return': 'error',
};

export default [
  {
    files: ['kc-snap.inline.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      // Exactly the browser globals the page uses, plus the two CDN libraries.
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        location: 'readonly', history: 'readonly', performance: 'readonly',
        console: 'readonly', crypto: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        Image: 'readonly', File: 'readonly', Blob: 'readonly', atob: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        HTMLCanvasElement: 'readonly', OffscreenCanvas: 'readonly',   // watched for lost WebGL contexts
        MediaRecorder: 'readonly',        // the Flipbook video
        Peer: 'readonly',                 // PeerJS, from jsdelivr
        SelfieSegmentation: 'readonly',   // MediaPipe, from jsdelivr
      },
    },
    // no-use-before-define is deliberately off: the app is one IIFE whose
    // functions refer to state declared further down and only run after all
    // of it is initialised. The test suite loads the page, which is what
    // catches a temporal-dead-zone mistake at startup.
    rules: bugRules,
  },
  {
    files: ['tests/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly', Buffer: 'readonly', console: 'readonly',
        setImmediate: 'readonly', queueMicrotask: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', File: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: bugRules,
  },
];
