/**
 * tests/server.error.test.js
 * -----------------------------------------------------------------------------
 * ERROR / FAILURE-MODE SUITE for the root `server.js` HTTP server.
 *
 * Scope (AAP §0.4.2, §0.5.2):
 *   - ECONNREFUSED before startup : connecting to 127.0.0.1:3000 while NOTHING
 *                                   is listening yields a socket 'error' whose
 *                                   `code === 'ECONNREFUSED'`.
 *   - EADDRINUSE on double-bind    : a SECOND `node server.js` cannot bind the
 *                                   already-occupied port 3000. Because
 *                                   `server.js` registers NO `'error'` event
 *                                   handler, the unhandled error crashes that
 *                                   process — it exits NON-ZERO (empirically
 *                                   code 1) with `EADDRINUSE` on stderr.
 *   - Malformed-input resilience   : non-HTTP bytes make Node reply
 *                                   `HTTP/1.1 400 Bad Request` and close THAT
 *                                   connection, but the server PROCESS stays
 *                                   alive and keeps serving valid traffic.
 *   - ECONNREFUSED after shutdown  : once the server is stopped the listening
 *                                   socket is released, so new connections are
 *                                   refused again.
 *
 * BLACK-BOX MANDATE (AAP §0.10.1): `server.js` binds 127.0.0.1:3000 as a
 * load-time side effect and exports nothing, so it is NEVER required in-process
 * (doing so would leak an unclosable handle and hang Jest). Every failure mode
 * is exercised against a REAL spawned child process over raw TCP sockets
 * (`net`), a direct `child_process.spawn`, and a plain `http.get`. No
 * application internals are mocked — the "test doubles" are genuine OS
 * processes and loopback connections, so `server.js` remains byte-for-byte
 * unchanged (REFERENCE-only).
 *
 * KEY INSIGHTS (empirically verified against the system under test):
 *   - EADDRINUSE manifests as a PROCESS-LEVEL crash (non-zero exit), NOT an
 *     in-process event, precisely because `server.js` lacks an `'error'`
 *     handler. The assertion therefore inspects the child's exit code and/or
 *     stderr — never an in-process listener.
 *   - Malformed input yields a `400` on that single connection but does NOT
 *     crash the process; "still alive" is proven by the handle's native
 *     `exitCode === null` PLUS a follow-up successful `200`.
 *   - ORDER MATTERS: the pre-start ECONNREFUSED assertion is only meaningful
 *     while port 3000 is free, so it is declared FIRST and this suite uses NO
 *     shared `beforeAll(startServer)` — each test owns its own start/stop.
 *
 * PORT CONTENTION (AAP §0.7.2, §0.9.1, §0.10.3): this suite binds and contends
 * for the hardcoded port 3000, so it MUST tear down deterministically and be
 * run serially with `--runInBand` so no two instances bind port 3000 at once.
 * Every test that starts the primary server stops it before returning, and the
 * `afterEach`/`afterAll` net forcibly reaps any survivor of a failed test.
 *
 * Module style : CommonJS (the repository declares no `"type": "module"`).
 * Timeout      : the 15000 ms per-test budget is inherited from `jest.config.js`.
 * Fixtures     : connection targets (`HOST`, `PORT`) come from
 *                `tests/fixtures/expectations.js` — nothing is hardcoded here.
 */

'use strict';

const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

// Relative to this file at `tests/server.error.test.js`, the shared helper and
// fixture modules live in the sibling `tests/helpers/` and `tests/fixtures/`
// directories — hence the `./` specifiers (NOT `../`, which would point above
// the `tests/` directory). The helper itself (in `tests/helpers/`) uses
// `../fixtures/expectations`; this suite, being one level shallower, uses `./`.
const { startServer, stopServer } = require('./helpers/serverProcess');
const { HOST, PORT } = require('./fixtures/expectations');

// Entry file spawned as the system under test (relative to `repoRoot` below).
const SERVER_ENTRY = 'server.js';

// Repository root. This file lives at `<root>/tests/`, so one level up is the
// repo root where `server.js` resides. Used as the `cwd` for any direct
// `spawn('node', [SERVER_ENTRY])` so the relative entry argument resolves.
const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CHILD-PROCESS TRACKING — deterministic teardown safety net
// ---------------------------------------------------------------------------
// Every child this suite spawns (primary servers via startServer() and the
// second EADDRINUSE instance via spawn()) is registered here. Passing tests
// reap their own children explicitly; `killSurvivors()` (wired into
// afterEach/afterAll) only fires for a test that threw before its own teardown,
// guaranteeing no orphaned `node server.js` keeps port 3000 bound for the next
// test or sibling suite.
const spawnedChildren = [];

/**
 * Register a spawned child for guaranteed cleanup and return it unchanged so it
 * can be used inline: `const server = track(await startServer());`.
 *
 * @template {import('child_process').ChildProcess} T
 * @param {T} child
 * @returns {T}
 */
function track(child) {
  if (child) {
    spawnedChildren.push(child);
  }
  return child;
}

/**
 * Await a child's termination and resolve once it has genuinely exited, or after
 * a bounded fallback timeout so a stuck reap can NEVER hang teardown. Resolves
 * (never rejects) — cleanup is fire-and-forget safe. Mirrors the await-on-'exit'
 * discipline of `stopServer()` in `tests/helpers/serverProcess.js`.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<void>}
 */
function awaitChildExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    // Already terminated: a normal exit reports a numeric `exitCode`; a
    // signal-kill reports `signalCode`. Either means there is nothing to await.
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    // Safety net: never block teardown indefinitely if the 'exit' somehow does
    // not arrive. The timer is unref'd so it cannot itself keep Node alive.
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    child.once('exit', finish);
  });
}

/**
 * Force-terminate any tracked child that is still running, AWAIT its exit, then
 * clear the registry. A Node child that exited normally reports a numeric
 * `exitCode`; one terminated by signal reports `signalCode` (e.g. 'SIGTERM'). A
 * child that is still alive reports BOTH as `null` — only those are killed here,
 * so this never double-signals an already-stopped process.
 *
 * Deterministic teardown (AAP §0.7.2, §0.10.3): after sending SIGKILL we WAIT
 * for the child's 'exit' (bounded) before returning, because the OS only
 * reclaims the process's listening socket on port 3000 once the process is
 * actually gone. Without that wait the next test/suite could begin while a
 * just-killed process still momentarily holds the port — the exact contention
 * this safety net exists to prevent. When a survivor was actually reaped we
 * additionally poll briefly until port 3000 is observably refused, absorbing any
 * residual OS port-release latency. Both steps run ONLY on the (rare) failure
 * path where a survivor existed, so the green path incurs no added latency.
 *
 * @returns {Promise<void>}
 */
async function killSurvivors() {
  let killedAny = false;
  while (spawnedChildren.length > 0) {
    const child = spawnedChildren.pop();
    if (!child) {
      continue;
    }
    const stillRunning = child.exitCode === null && child.signalCode === null;
    if (stillRunning) {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        // Process vanished between the liveness check and the kill — ignore.
      }
      // Block until the killed child is truly gone (bounded) so its port-3000
      // socket is released before this cleanup returns.
      await awaitChildExit(child);
      killedAny = true;
    }
  }

  // Only when a survivor was actually reaped do we confirm the port is free
  // again, tolerating brief OS port-release latency. Bounded so cleanup can
  // never hang; `connectExpectingError` resolves a sentinel rather than throwing.
  if (killedAny) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if ((await connectExpectingError(HOST, PORT)) === 'ECONNREFUSED') {
        break;
      }
      await delay(100);
    }
  }
}

/**
 * Small promisified delay used to space out connection-refused polling while a
 * just-stopped server releases its listening socket.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Attempt a raw TCP connection and report the OUTCOME as a short string, never
 * throwing. Resolves with:
 *   - the POSIX error `code` (e.g. 'ECONNREFUSED') if the socket emits 'error',
 *   - 'CONNECTED' if it unexpectedly establishes a connection (something IS
 *     listening), or
 *   - 'TIMEOUT' if neither happens within `timeoutMs`.
 * The socket is ALWAYS destroyed so no file descriptor lingers between attempts.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs=1000]
 * @returns {Promise<string>}
 */
function connectExpectingError(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      // Always release the descriptor, regardless of how we got here.
      try {
        socket.destroy();
      } catch (_) {
        // Socket already destroyed — nothing to clean up.
      }
      resolve(result);
    };

    // A refused/unreachable port emits 'error' carrying a POSIX code string.
    socket.once('error', (err) => finish(err && err.code ? err.code : 'ERROR'));
    // An unexpected successful connect means a server IS bound to the port.
    socket.once('connect', () => finish('CONNECTED'));
    // Guard against a hung connect (e.g. a silently dropped SYN).
    socket.setTimeout(timeoutMs, () => finish('TIMEOUT'));
  });
}

/**
 * Await a spawned child's termination and resolve with its exit status. Used
 * for the SECOND (failing) `server.js` instance, which self-terminates because
 * `server.js` has no `'error'` handler. Resolves with `{ code, signal }` on
 * 'exit'; on the (unexpected) timeout it resolves a sentinel so the suite can
 * never hang — `afterEach` cleanup reaps any genuine survivor.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<{ code: number|null, signal: NodeJS.Signals|null, timedOut?: boolean, error?: Error }>}
 */
function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      // Sentinel: the child did NOT exit within budget. Not expected for the
      // EADDRINUSE case — kept only so a stuck child surfaces as a clear value
      // instead of an opaque Jest timeout.
      finish({ code: null, signal: null, timedOut: true });
    }, timeoutMs);
    // Do not let the safety timer itself keep the event loop alive.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    // 'exit' carries the authoritative (code, signal) the instant the process
    // ends and is guaranteed to fire for a process that terminates.
    child.once('exit', (code, signal) => finish({ code, signal }));
    // A spawn-level failure (e.g. 'node' not found) also unblocks the waiter.
    child.once('error', (err) => finish({ code: null, signal: null, error: err }));
  });
}

/**
 * Open a raw socket, write deliberately malformed (non-HTTP) bytes, and resolve
 * with whatever the server writes back before the connection closes. Node's
 * HTTP parser answers an unparseable request line with `400 Bad Request` and
 * then closes the connection; the server PROCESS, however, stays alive. The
 * socket is always destroyed.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<string>} the raw bytes the server replied with (may be '').
 */
function sendMalformedBytes(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    let raw = '';

    const socket = net.createConnection({ host, port }, () => {
      // A non-HTTP request line terminated by a blank line → Node replies 400.
      socket.write('@@@ GARBAGE NOT-HTTP \r\n\r\n');
    });
    socket.setEncoding('utf8');

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch (_) {
        // Already gone.
      }
      resolve(raw);
    };

    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    socket.on('data', (chunk) => {
      raw += chunk;
    });
    // The server closes the connection right after the 400 — that resolves us.
    socket.once('close', finish);
    socket.once('error', finish);
  });
}

/**
 * Issue a fresh, well-formed GET and resolve with its numeric status code,
 * draining the response body so the socket is freed and no handle lingers.
 * Used to prove the server PROCESS is still serving valid traffic after it was
 * sent malformed bytes. A plain `http.get` is preferred here over Supertest to
 * keep this error suite's dependency surface limited to Node built-ins.
 *
 * @param {string} host
 * @param {number} port
 * @param {string} requestPath
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<number>} the HTTP status code (e.g. 200).
 */
function httpGetStatus(host, port, requestPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: requestPath }, (res) => {
      // Drain the body so the underlying socket is released promptly.
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`http.get timed out after ${timeoutMs} ms`));
    });
    req.once('error', reject);
  });
}

describe('server.js error handling', () => {
  // Defensive teardown net. Passing tests reap their own children explicitly;
  // these hooks only fire for a test that threw before its own cleanup, so no
  // orphaned `node server.js` survives to bind port 3000 for the next test or
  // the sibling suites running under the same `--runInBand` process.
  afterEach(async () => {
    await killSurvivors();
  });

  afterAll(async () => {
    await killSurvivors();
  });

  // ---------------------------------------------------------------------------
  // 1. ECONNREFUSED BEFORE STARTUP  (MUST be the first test — no server bound)
  // ---------------------------------------------------------------------------
  // Declared FIRST and intentionally NOT guarded by a shared
  // `beforeAll(startServer)`: the pre-start assertion is only meaningful while
  // port 3000 is free. Jest preserves declaration order, so this runs before
  // any test in this file binds the port; `--runInBand` (mandated for
  // port-binding suites) ensures no sibling suite holds it concurrently either.
  test('refuses connections before the server starts (ECONNREFUSED)', async () => {
    await expect(connectExpectingError(HOST, PORT)).resolves.toBe('ECONNREFUSED');
  });

  // ---------------------------------------------------------------------------
  // 2. EADDRINUSE  — a second instance cannot bind the occupied port 3000
  // ---------------------------------------------------------------------------
  // `server.js` registers NO `'error'` event handler, so when a second instance
  // fails to bind the already-occupied port the unhandled error crashes that
  // process: it exits NON-ZERO (empirically code 1) with 'EADDRINUSE' on
  // stderr. The assertion inspects the child's EXIT STATUS (and/or stderr),
  // never an in-process event — the failure is a process-level crash by design,
  // which is exactly why this test cannot hang (the second instance self-exits).
  test('a second instance binding port 3000 fails with EADDRINUSE / non-zero exit', async () => {
    // Primary occupies port 3000 (tracked for guaranteed teardown).
    const server = track(await startServer());

    // Spawn a SECOND instance DIRECTLY (not via the helper) so its raw stderr
    // stream is observable. `cwd` is the repo root so the relative 'server.js'
    // argument resolves to the file under test.
    const second = track(spawn('node', [SERVER_ENTRY], { cwd: repoRoot }));

    // Accumulate the second instance's stderr (the unhandled EADDRINUSE trace).
    let secondStderr = '';
    if (second.stderr) {
      second.stderr.setEncoding('utf8');
      second.stderr.on('data', (chunk) => {
        secondStderr += chunk;
      });
    }

    // The second instance self-terminates — await its FULL exit status so the
    // safety sentinels can be rejected BEFORE any success branch is evaluated.
    const { code, timedOut, error } = await waitForExit(second);

    // GUARD — reject the safety sentinels first so a hung or un-spawnable child
    // can NEVER satisfy this test. `waitForExit` resolves `{ timedOut: true }`
    // (with `code: null`) if the child never exits within budget, and
    // `{ error }` if the spawn itself failed (e.g. 'node' missing). Neither
    // proves a port-bind failure — and the timeout sentinel's `code: null` is
    // exactly what a naive `code !== 0` check wrongly accepted (null !== 0).
    expect(timedOut).not.toBe(true);
    expect(error).toBeUndefined();

    // The child must have genuinely terminated with a REAL (non-null) exit code.
    // After the guard above a timeout is impossible, but requiring a non-null
    // code keeps the non-zero-exit branch below honest (a signal-kill would
    // surface `code === null`). Empirically the second instance self-exits with
    // code 1 because `server.js` registers no `'error'` handler.
    expect(code).not.toBeNull();

    // Failure is proven by a NON-ZERO exit code OR an EADDRINUSE stderr message.
    // Empirically BOTH hold (code === 1 AND stderr includes 'EADDRINUSE'); the
    // OR keeps the assertion robust against any stderr-capture timing race, while
    // the guards above ensure a clean exit (code 0) or a non-exit cannot pass.
    expect(code !== 0 || /EADDRINUSE/.test(secondStderr)).toBe(true);

    // The primary remained healthy throughout the contention — its native
    // ChildProcess `exitCode` is still null (the process is running).
    expect(server.exitCode).toBeNull();

    // Deterministic teardown so port 3000 is released for the next test.
    await stopServer(server);
  });

  // ---------------------------------------------------------------------------
  // 3. MALFORMED INPUT RESILIENCE — bad bytes do not crash the process
  // ---------------------------------------------------------------------------
  // Writing non-HTTP bytes makes Node's parser reply `HTTP/1.1 400 Bad Request`
  // and close THAT connection, but the server PROCESS stays alive and keeps
  // serving. Liveness is proven two independent ways: the handle's native
  // `exitCode` is still null, AND a fresh valid GET still returns 200.
  test('stays alive after receiving malformed bytes', async () => {
    const server = track(await startServer());

    // Send garbage over a raw socket and capture whatever the server replies.
    const malformedReply = await sendMalformedBytes(HOST, PORT);

    // Node answers a malformed request line with a 400 before closing it.
    expect(malformedReply).toMatch(/400/);

    // The PROCESS did not crash — `exitCode` is the native ChildProcess
    // property, which stays null while the process runs.
    expect(server.exitCode).toBeNull();

    // …and it still serves valid traffic: a fresh GET returns a 200 status.
    const status = await httpGetStatus(HOST, PORT, '/');
    expect(status).toBe(200);

    await stopServer(server);
  });

  // ---------------------------------------------------------------------------
  // 4. ECONNREFUSED AFTER SHUTDOWN — the port is released on stop
  // ---------------------------------------------------------------------------
  // After a clean stop the listening socket is gone, so new connections are
  // refused again. We poll briefly to absorb any port-release latency before
  // asserting ECONNREFUSED.
  test('refuses connections after the server stops (ECONNREFUSED)', async () => {
    const server = track(await startServer());
    await stopServer(server);

    // Poll: retry a handful of times until the port is observably refused,
    // tolerating any brief OS port-release latency after the process exits.
    let lastResult = 'pending';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      lastResult = await connectExpectingError(HOST, PORT);
      if (lastResult === 'ECONNREFUSED') {
        break;
      }
      await delay(200);
    }

    expect(lastResult).toBe('ECONNREFUSED');
  });
});

