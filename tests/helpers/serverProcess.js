'use strict';

/**
 * tests/helpers/serverProcess.js
 *
 * Shared process-lifecycle utility for the black-box test suite of the root
 * `server.js` HTTP server. Imported by ALL behavioral suites
 * (server.response, server.lifecycle, server.error, server.edge).
 *
 * Design rationale (see AAP §0.4.4, §0.5.2, §0.10.1):
 *   - `server.js` binds 127.0.0.1:3000 as a *load-time side effect* and exports
 *     nothing, so it must NEVER be required in-process (doing so would leak an
 *     unclosable handle and hang Jest). Instead we spawn it as a REAL child
 *     process and exercise it over real HTTP / sockets. No application internals
 *     are mocked — the "test doubles" are genuine OS processes and connections.
 *
 * Module style: CommonJS (the repo has no `"type": "module"`).
 *
 * Public contract:
 *   module.exports = { startServer, stopServer };
 *
 *   startServer()  -> Promise<ChildProcess handle> resolved once the readiness
 *                     banner appears on stdout. The resolved handle exposes:
 *                       • handle.stdout      -> STRING of captured stdout (live)
 *                       • handle.stdoutData  -> alias of the captured stdout string
 *                       • handle.stderr      -> STRING of captured stderr (live)
 *                       • handle.stderrData  -> alias of the captured stderr string
 *                       • handle.exitCode    -> NATIVE child exitCode (null while running)
 *                     and remains a real ChildProcess (supports .kill(), events, etc.).
 *
 *   stopServer(child, signal = 'SIGTERM') -> Promise<{ code, signal }> that sends
 *                     the signal, awaits process exit, and resolves with the exit
 *                     info. Idempotent: resolves immediately if the child already
 *                     exited. Guarantees deterministic teardown so port 3000 is
 *                     released for serial (`--runInBand`) execution.
 */

const { spawn } = require('child_process');
const path = require('path');
const { STARTUP_BANNER } = require('../fixtures/expectations');

// Repository root: this file lives at <root>/tests/helpers/, so two levels up
// is the repo root where server.js resides.
const REPO_ROOT = path.resolve(__dirname, '../..');

// Entry file spawned as the system under test.
const SERVER_ENTRY = 'server.js';

// Readiness timeout MUST be strictly less than the global Jest testTimeout (15000 ms)
// so a stuck spawn surfaces as a clear helper error rather than an opaque Jest timeout.
const DEFAULT_READINESS_TIMEOUT_MS = 10000;

/**
 * Spawn `node server.js` and resolve once it is ready to serve.
 *
 * @param {object} [options]
 * @param {number} [options.readinessTimeoutMs=10000] Max ms to wait for the banner.
 * @returns {Promise<import('child_process').ChildProcess>} the augmented child handle.
 */
function startServer({ readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_ENTRY], { cwd: REPO_ROOT });

    let stdoutData = '';
    let stderrData = '';
    let settled = false;

    // Build a fresh, NON-global matcher from the shared banner so repeated
    // `.test()` calls are stateless (defensive against a future global flag).
    const bannerRegex = new RegExp(STARTUP_BANNER.source);

    // Capture the native stdio streams BEFORE we re-expose the properties as
    // string getters. The listeners stay bound to these saved stream references.
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdoutStream) stdoutStream.setEncoding('utf8');
    if (stderrStream) stderrStream.setEncoding('utf8');

    // Re-expose captured output as live STRING getters on the handle. The
    // lifecycle suite reads `server.stdout` as a string (String.prototype.match),
    // so `stdout`/`stderr` must return the accumulated text, not the raw stream.
    // `exitCode` is intentionally left as the native ChildProcess property.
    Object.defineProperty(child, 'stdout', {
      configurable: true,
      enumerable: true,
      get() { return stdoutData; },
    });
    Object.defineProperty(child, 'stdoutData', {
      configurable: true,
      enumerable: true,
      get() { return stdoutData; },
    });
    Object.defineProperty(child, 'stderr', {
      configurable: true,
      enumerable: true,
      get() { return stderrData; },
    });
    Object.defineProperty(child, 'stderrData', {
      configurable: true,
      enumerable: true,
      get() { return stderrData; },
    });

    const onStdout = (chunk) => {
      stdoutData += chunk;
      if (!settled && bannerRegex.test(stdoutData)) {
        onReady();
      }
    };

    const onStderr = (chunk) => {
      stderrData += chunk;
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      finishWatching();
      reject(new Error(`Failed to spawn ${SERVER_ENTRY}: ${err.message}`));
    };

    const onPrematureExit = (code, signal) => {
      if (settled) return;
      settled = true;
      finishWatching();
      reject(new Error(
        `${SERVER_ENTRY} exited before the readiness banner ` +
        `(code=${code}, signal=${signal}). stderr: ${stderrData.trim()}`
      ));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      finishWatching();
      // Avoid leaking the process if it never became ready.
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      reject(new Error(
        `Timed out after ${readinessTimeoutMs} ms waiting for the ` +
        `${SERVER_ENTRY} readiness banner. ` +
        `stdout: ${JSON.stringify(stdoutData)} stderr: ${JSON.stringify(stderrData)}`
      ));
    }, readinessTimeoutMs);
    // Do not let the readiness timer itself keep the event loop alive.
    if (typeof timer.unref === 'function') timer.unref();

    // Stop the startup watchers/timer. Keeps the stdout/stderr 'data' listeners
    // attached so captured output stays live for the lifetime of the process.
    function finishWatching() {
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onPrematureExit);
    }

    function onReady() {
      if (settled) return;
      settled = true;
      finishWatching();
      resolve(child);
    }

    if (stdoutStream) stdoutStream.on('data', onStdout);
    if (stderrStream) stderrStream.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onPrematureExit);
  });
}

/**
 * Terminate a spawned server and await its exit. Idempotent and deterministic.
 *
 * @param {import('child_process').ChildProcess} child handle from startServer().
 * @param {NodeJS.Signals} [signal='SIGTERM'] termination signal to send.
 * @returns {Promise<{ code: number|null, signal: NodeJS.Signals|null }>}
 */
function stopServer(child, signal = 'SIGTERM') {
  return new Promise((resolve) => {
    if (!child) {
      resolve({ code: null, signal: null });
      return;
    }

    // Idempotent fast path: the process has already exited. A Node process that
    // exited normally reports a numeric exitCode; one killed by signal reports
    // exitCode === null with signalCode set.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }

    child.once('exit', (code, sig) => {
      resolve({ code, signal: sig });
    });

    try {
      child.kill(signal);
    } catch (_) {
      // Process vanished between the liveness check and the kill — resolve with
      // whatever the runtime now reports.
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

module.exports = { startServer, stopServer };
