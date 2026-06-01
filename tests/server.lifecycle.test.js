/**
 * tests/server.lifecycle.test.js
 * -----------------------------------------------------------------------------
 * STARTUP / SHUTDOWN INTEGRATION SUITE for the root `server.js` HTTP server.
 *
 * Scope (AAP §0.4.2, §0.5.2):
 *   - Startup banner      : `server.js` logs EXACTLY `Server running at
 *                           http://127.0.0.1:3000/` once, from its
 *                           `server.listen` callback. Counting matches in the
 *                           captured stdout proves single-fire.
 *   - Port reachability   : after startup the server is bound to 127.0.0.1:3000
 *                           and accepts TCP connections.
 *   - Graceful shutdown   : `server.js` registers NO signal/shutdown handler, so
 *                           SIGTERM/SIGINT terminate it via Node's DEFAULT
 *                           action. A signal-killed Node process reports
 *                           `code === null` with `signal` set (e.g. 'SIGTERM' /
 *                           'SIGINT') on its 'exit' event — NEVER `code === 0`.
 *   - Port release        : once the process exits its listening socket is
 *                           freed, so subsequent connections are refused
 *                           (ECONNREFUSED).
 *
 * BLACK-BOX MANDATE (AAP §0.10.1): `server.js` binds 127.0.0.1:3000 as a
 * load-time side effect and exports nothing, so it is NEVER required in-process
 * (doing so would bind port 3000 with no handle to close and hang Jest on an
 * open handle). Every lifecycle behavior is exercised against a REAL spawned
 * child process — launched/stopped through `tests/helpers/serverProcess.js` —
 * and probed over raw TCP using Node's built-in `net`. No application internals
 * are mocked, so `server.js` stays byte-for-byte unchanged (REFERENCE-only).
 *
 * SELF-MANAGED LIFECYCLE (AAP §0.10.3): unlike the response/edge suites, this
 * file does NOT use a shared `beforeAll(startServer)`. Each test starts AND
 * stops its OWN server because it must observe startup and shutdown directly
 * and must fully release port 3000 before the next test binds it. Tests that
 * assert port release additionally await `expectConnectionRefused`, so the next
 * test only begins once the socket is provably gone.
 *
 * PORT CONTENTION (AAP §0.7.2, §0.9.1, §0.10.3): this suite binds and contends
 * for the hardcoded port 3000, so it MUST tear down deterministically and be
 * run serially with `--runInBand`. A module-scoped registry plus an `afterEach`
 * safety net reaps any child a failing test left running, guaranteeing no
 * orphaned `node server.js` keeps the port bound for the next test or a sibling
 * suite.
 *
 * Module style : CommonJS (the repository declares no `"type": "module"`).
 * Timeout      : the 15000 ms per-test budget is inherited from `jest.config.js`.
 * Fixtures     : the startup-banner RegExp and the connection target (`HOST`,
 *                `PORT`) come from `tests/fixtures/expectations.js` — nothing is
 *                hardcoded here.
 */

'use strict';

const net = require('net');
// This file lives at `tests/server.lifecycle.test.js`, so the shared helper and
// fixture modules in the sibling `tests/helpers/` and `tests/fixtures/`
// directories are reached with `./` specifiers (NOT `../`, which would point
// ABOVE the `tests/` directory to a non-existent repo-root `helpers/`). The
// helper itself, living one level deeper in `tests/helpers/`, uses
// `../fixtures/expectations`; this suite, being one level shallower, uses `./`.
const { startServer, stopServer } = require('./helpers/serverProcess');
const { STARTUP_BANNER, HOST, PORT } = require('./fixtures/expectations');

// ---------------------------------------------------------------------------
// CHILD-PROCESS TRACKING — deterministic teardown safety net
// ---------------------------------------------------------------------------
// Every server this suite spawns is registered here the instant it is created.
// Passing tests stop their own server explicitly (and `stopServer` is
// idempotent, so the afterEach re-stop is a cheap no-op). The registry exists
// for the FAILURE path: if a test throws before its explicit stop, `afterEach`
// still reaps the child so no orphaned `node server.js` survives to hold port
// 3000 for the next test or a sibling suite under `--runInBand`.
const spawnedServers = [];

/**
 * Register a spawned server handle for guaranteed cleanup and return it
 * unchanged so it can be captured inline:
 *   `const server = track(await startServer());`
 *
 * @template {import('child_process').ChildProcess} T
 * @param {T} child the handle returned by `startServer()`.
 * @returns {T} the same handle, untouched.
 */
function track(child) {
  if (child) {
    spawnedServers.push(child);
  }
  return child;
}

/**
 * Attempt a single raw TCP connection and report whether the port ACCEPTS it.
 * Resolves:
 *   - `true`            once the socket emits `'connect'` (something is
 *                       listening and accepted the connection),
 *   - the POSIX error `code` string (e.g. `'ECONNREFUSED'`) if the socket
 *     emits `'error'` — falling back to `false` when no code is present, and
 *   - `false`           if neither happens within `timeoutMs`.
 * The socket is ALWAYS destroyed before resolving so no file descriptor lingers
 * between probes. Never rejects — callers assert on the resolved value.
 *
 * @param {string} host target host (loopback `127.0.0.1`).
 * @param {number} port target port (3000).
 * @param {number} [timeoutMs=1000] max ms to wait for connect/error.
 * @returns {Promise<boolean|string>} `true` on connect, else `false`/error code.
 */
function canConnect(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      // Release the descriptor regardless of how we reached this point.
      try {
        socket.destroy();
      } catch (_) {
        // Socket already destroyed — nothing to clean up.
      }
      resolve(result);
    };

    // The port accepted the connection — the server is reachable.
    socket.once('connect', () => finish(true));
    // A refused/unreachable port emits 'error' carrying a POSIX code string.
    socket.once('error', (err) => finish(err && err.code ? err.code : false));
    // Guard against a hung connect (e.g. a silently dropped SYN).
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * Poll a port until connections are REFUSED, absorbing the brief, non-
 * deterministic delay between a child process exiting and the OS reclaiming its
 * listening socket. Resolves `true` as soon as a connection attempt fails with
 * `code === 'ECONNREFUSED'`; resolves `false` if the port is still accepting (or
 * failing some other way) after `retries` attempts spaced `delayMs` apart.
 * Never rejects, and never leaves a socket open between attempts.
 *
 * @param {string} host target host (loopback `127.0.0.1`).
 * @param {number} port target port (3000).
 * @param {object} [options]
 * @param {number} [options.retries=20] max connection attempts before giving up.
 * @param {number} [options.delayMs=100] ms to wait between attempts.
 * @returns {Promise<boolean>} `true` once ECONNREFUSED is observed, else `false`.
 */
function expectConnectionRefused(host, port, { retries = 20, delayMs = 100 } = {}) {
  return new Promise((resolve) => {
    let attempts = 0;

    const attempt = () => {
      attempts += 1;
      let settled = false;
      const socket = net.createConnection({ host, port });

      const cleanup = () => {
        try {
          socket.destroy();
        } catch (_) {
          // Already gone.
        }
      };

      // Decide the outcome of THIS attempt, then either resolve or schedule a
      // retry. `refused === true` means we observed ECONNREFUSED (success).
      const decide = (refused) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        if (refused) {
          resolve(true);
          return;
        }
        if (attempts >= retries) {
          // Exhausted the budget while the port was still reachable / erroring
          // some other way — report failure rather than hang.
          resolve(false);
          return;
        }
        // Space out the next probe to let the OS finish releasing the socket.
        const retryTimer = setTimeout(attempt, delayMs);
        // Do not let the retry timer keep the event loop (or Jest) alive.
        if (typeof retryTimer.unref === 'function') {
          retryTimer.unref();
        }
      };

      // ECONNREFUSED is the success signal; any other error is treated as
      // "not yet refused" and retried (the socket is gone in either case).
      socket.once('error', (err) => decide(Boolean(err) && err.code === 'ECONNREFUSED'));
      // A successful connect means something is STILL listening — retry.
      socket.once('connect', () => decide(false));
      // A hung connect attempt is inconclusive — treat as "retry".
      socket.setTimeout(1000, () => decide(false));
    };

    attempt();
  });
}

describe('server.js lifecycle', () => {
  // Defensive teardown net. Passing tests stop their own server explicitly;
  // this hook only does real work for a test that threw before its explicit
  // stop. `stopServer` is idempotent (it fast-paths when the child has already
  // exited), so re-stopping an already-stopped server is a harmless no-op and
  // any "already exited" error is swallowed. Draining the registry leaves a
  // clean slate — and a freed port 3000 — for the next test.
  afterEach(async () => {
    while (spawnedServers.length > 0) {
      const child = spawnedServers.pop();
      try {
        await stopServer(child);
      } catch (_) {
        // Child already exited or was never killable — nothing left to do.
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 1. STARTUP BANNER — logged exactly once on `listen`
  // ---------------------------------------------------------------------------
  // `server.js` prints its readiness banner from a SINGLE `console.log` inside
  // the `server.listen` callback. `startServer()` only resolves once that
  // banner has appeared on stdout, so the captured `stdout` string is
  // guaranteed to contain it. Counting matches with a GLOBAL clone of the
  // shared banner RegExp proves the banner fired EXACTLY once (no duplicate
  // listen callbacks, no repeated logging).
  test('logs the readiness banner exactly once on startup', async () => {
    const server = track(await startServer());

    // `server.stdout` is the accumulated stdout STRING (a getter on the
    // handle). `STARTUP_BANNER` is non-global, so build a global clone from its
    // `.source` to collect ALL occurrences rather than just the first.
    const matches = server.stdout.match(new RegExp(STARTUP_BANNER.source, 'g'));

    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(1);

    await stopServer(server);
  });

  // ---------------------------------------------------------------------------
  // 2. PORT REACHABILITY — 3000 is connectable after start
  // ---------------------------------------------------------------------------
  // Once the banner has been observed the server has finished binding
  // 127.0.0.1:3000 (the banner is logged from the `listen` callback, which only
  // runs after the socket is bound). A raw TCP connection therefore succeeds.
  test('port 3000 becomes connectable after start', async () => {
    const server = track(await startServer());

    await expect(canConnect(HOST, PORT)).resolves.toBe(true);

    await stopServer(server);
  });

  // ---------------------------------------------------------------------------
  // 3. SIGTERM — clean exit AND port release
  // ---------------------------------------------------------------------------
  // `server.js` installs no SIGTERM handler, so Node's default action
  // terminates the process. On the 'exit' event this surfaces as
  // `code === null, signal === 'SIGTERM'` — which `stopServer` returns as
  // `{ code: null, signal: 'SIGTERM' }`. "Clean" is therefore asserted as the
  // expected signal OR a zero exit code (defensive against environments that
  // might translate the signal into a 0 exit). After exit the listening socket
  // is released, so we poll until connections are refused.
  test('exits cleanly on SIGTERM and releases the port', async () => {
    const server = track(await startServer());

    const info = await stopServer(server, 'SIGTERM');

    // Signal-terminated Node processes report code === null with the signal
    // set; never assert ONLY code === 0 (that path does not occur here).
    expect(info.signal === 'SIGTERM' || info.code === 0).toBe(true);

    // The port must be free again now that the process is gone.
    await expect(expectConnectionRefused(HOST, PORT)).resolves.toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 4. SIGINT — clean exit AND port release
  // ---------------------------------------------------------------------------
  // Identical contract to SIGTERM but exercising the SIGINT path (Ctrl-C). With
  // no SIGINT handler in `server.js`, Node's default action ends the process,
  // reported as `{ code: null, signal: 'SIGINT' }`. Port release is confirmed
  // the same way.
  test('exits cleanly on SIGINT and releases the port', async () => {
    const server = track(await startServer());

    const info = await stopServer(server, 'SIGINT');

    expect(info.signal === 'SIGINT' || info.code === 0).toBe(true);

    await expect(expectConnectionRefused(HOST, PORT)).resolves.toBe(true);
  });
});
