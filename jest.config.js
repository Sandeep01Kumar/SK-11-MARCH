/**
 * Jest configuration for the `hello_world` HTTP server test suite.
 *
 * ---------------------------------------------------------------------------
 * MODULE FORMAT
 * ---------------------------------------------------------------------------
 * This file is authored as a CommonJS module (`module.exports`) to match the
 * repository's module style. `package.json` declares no `"type": "module"`
 * field, so Node.js (and therefore Jest) loads `.js` files as CommonJS. Do
 * NOT convert this to an ESM `export default`.
 *
 * ---------------------------------------------------------------------------
 * TEST STRATEGY: BLACK-BOX, PROCESS-LEVEL
 * ---------------------------------------------------------------------------
 * The system under test, `server.js`, is a minimal Node `http` server that
 * binds 127.0.0.1:3000 and responds `200` / `Content-Type: text/plain` /
 * body `Hello, World!\n` to every request, logging
 * `Server running at http://127.0.0.1:3000/` on startup.
 *
 * `server.js` exports nothing and calls `server.listen()` as a load-time side
 * effect, so it is NEVER imported in-process (doing so would bind port 3000
 * with no handle to close, risking open-handle hangs). Instead, the suites
 * launch it as a CHILD PROCESS (`node server.js`) via
 * `tests/helpers/serverProcess.js` and exercise it over real HTTP (Supertest)
 * and raw sockets (`net`). `server.js` therefore remains byte-for-byte
 * unchanged — it is a REFERENCE-only file.
 *
 * ---------------------------------------------------------------------------
 * COVERAGE NOTE (AAP §0.7.1) — READ BEFORE INTERPRETING COVERAGE NUMBERS
 * ---------------------------------------------------------------------------
 * Because `server.js` executes inside a *child* process, Jest's in-process V8
 * instrumentation cannot attribute line coverage to it: the coverage report
 * will read approximately 0% for `server.js` even though the behavioral suite
 * exercises 100% of its executable lines (status, body, both headers, every
 * method/path, lifecycle, and the connection-level error paths). This is an
 * expected, documented artifact of the black-box design — NOT a test failure.
 *
 * Since `server.js` is a 15-line single-handler module, the behavioral suite
 * covers every executable line by construction. If true numeric line coverage
 * on `server.js` is ever required, wrap the spawned process with an
 * out-of-process collector such as `c8` (e.g.
 * `c8 --include server.js node server.js`) or run the child with
 * `node --experimental-test-coverage`. That approach is intentionally NOT
 * enabled here to keep the configuration minimal and dependency-light.
 *
 * No `coverageThreshold` is defined: coverage is intentionally non-gating
 * (AAP §0.7.1, §0.8.2) precisely because the in-process number above does not
 * reflect the true behavioral coverage of a child process.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  // Use the Node.js test environment (not jsdom): the code under test is a
  // server-side HTTP server with no DOM/browser globals.
  testEnvironment: 'node',

  // Discover every behavioral suite under `tests/` — server.response,
  // server.lifecycle, server.error, and server.edge (AAP §0.9.2). The glob is
  // anchored to the `tests/` directory so helper and fixture modules
  // (tests/helpers/*, tests/fixtures/*) are imported by suites but never
  // executed as standalone test files.
  testMatch: ['**/tests/**/*.test.js'],

  // Generous 15s per-test budget to absorb child-process spawn latency and
  // TCP port-bind/teardown time on 127.0.0.1:3000 (AAP §0.4.1, §0.7.2).
  testTimeout: 15000,

  // Emit per-test pass/fail reporting for clear, granular suite output
  // (AAP §0.5.4).
  verbose: true,

  // Use the V8 coverage provider when coverage is requested via
  // `jest --coverage` (AAP §0.5.4). See the COVERAGE NOTE above regarding the
  // child-process attribution caveat.
  coverageProvider: 'v8',

  // Restrict coverage collection to the single system under test. `server.js`
  // is referenced here only as a string path — it is never `require()`d by the
  // test infrastructure (AAP §0.5.4).
  collectCoverageFrom: ['server.js'],
};
