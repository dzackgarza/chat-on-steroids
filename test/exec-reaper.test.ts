/**
 * The exec orphan reaper, against the shapes documented in
 * docs/exec-orphan-audit-2026-09-09.md: ~40 orphaned exec_command wait-loops (several of
 * them `pgrep -f` loops matching their own command line, structurally unable to exit) and
 * a dozen stranded servers that outlived their sessions, none of which anything reaped
 * while the daemon ran.
 *
 * Real child processes throughout; a reaper proven against fakes proves nothing about
 * whether a pid actually dies.
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startupExecOrphanSweep,
  sweepExecOrphans,
  scanMarkedProcesses
} from '../src/main/exec-reaper.js';
import {
  EXEC_SPAWN_MARKER_ENV,
  execSpawnMarkerValue,
  parseExecSpawnMarker
} from '../src/main/exec-spawn-marker.js';
import { UnifiedExecProcessManager, applyUnifiedExecEnv } from '../src/main/codex/unified-exec.js';
import { DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS } from '../src/main/codex/unified-exec-constants.js';
import { IS_WINDOWS } from './helpers.js';

const IS_LINUX = process.platform === 'linux';
const truncationPolicy = { kind: 'tokens' as const, tokens: 10_000 };
const LIFETIME_MS = 60_000;
/** A clock far enough ahead that anything spawned "now" is aged well past the lifetime. */
const LONG_AFTER = (): number => Date.now() + 20 * 60_000;

interface LogLine {
  level: 'info' | 'warn';
  message: string;
}

function collector(): { lines: LogLine[]; log: { info: (m: string) => void; warn: (m: string) => void } } {
  const lines: LogLine[] = [];
  return {
    lines,
    log: {
      info: (message) => lines.push({ level: 'info', message }),
      warn: (message) => lines.push({ level: 'warn', message })
    }
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Kill leftovers even when an assertion failed before a test's own cleanup ran. */
const cleanupPids: number[] = [];
const cleanupManagers: UnifiedExecProcessManager[] = [];

afterEach(async () => {
  for (const manager of cleanupManagers.splice(0)) await manager.terminateAllProcesses();
  for (const pid of cleanupPids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* not a group leader or already gone */
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

function makeManager(): UnifiedExecProcessManager {
  const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
  cleanupManagers.push(manager);
  return manager;
}

/** Spawns a session through the manager exactly the way exec_command does. */
async function spawnSession(
  manager: UnifiedExecProcessManager,
  argv: string[],
  hookCommand: string
): Promise<{ processId: number; pid: number }> {
  const processId = manager.allocateProcessId();
  const output = await manager.execCommand({
    command: argv,
    shellType: 'bash',
    hookCommand,
    processId,
    yieldTimeMs: 250,
    maxOutputTokens: undefined,
    truncationPolicy,
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env),
    tty: false
  });
  expect(output.processId).toBe(processId);
  const listed = manager.listProcesses().find((entry) => entry.processId === processId);
  if (!listed) throw new Error('session was not stored as live');
  cleanupPids.push(listed.pid);
  return { processId, pid: listed.pid };
}

/** A directly spawned marked survivor, standing in for a descendant that outlived its session. */
function spawnMarkedOrphan(markerValue: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [EXEC_SPAWN_MARKER_ENV]: markerValue }
    });
    child.once('error', reject);
    child.once('spawn', () => {
      const pid = child.pid;
      child.unref();
      if (pid === undefined) reject(new Error('no pid'));
      else {
        cleanupPids.push(pid);
        resolve(pid);
      }
    });
  });
}

describe.skipIf(IS_WINDOWS)('idle-session reaping', () => {
  it('reaps the documented shape: a self-matching pgrep poll loop whose owning call ended long ago', async () => {
    const manager = makeManager();
    const marker = `clf-reaper-selfmatch-${randomBytes(4).toString('hex')}`;
    // The loop's own sh command line contains the pattern, so pgrep -f always finds at
    // least the loop itself and the loop can never exit — exactly the orphans found at
    // the Sep 9 restart. Only a lifetime bound can end it, which is the point.
    const script = `while pgrep -f ${marker} >/dev/null 2>&1; do sleep 0.2; done`;
    const { processId, pid } = await spawnSession(manager, ['/bin/sh', '-c', script], script);
    expect(pidAlive(pid)).toBe(true);

    const { lines, log } = collector();
    const result = await sweepExecOrphans(manager, { lifetimeMs: LIFETIME_MS, log, now: LONG_AFTER() });

    expect(result.reapedSessions).toBe(1);
    await waitFor(() => !pidAlive(pid), `pid ${pid} to die`);
    expect(manager.listProcesses().some((entry) => entry.processId === processId)).toBe(false);

    const reapLine = lines.find((line) => line.level === 'warn' && line.message.includes(`pid ${pid}`));
    expect(reapLine).toBeDefined();
    expect(reapLine!.message).toContain(`orphaned exec session ${processId}`);
    expect(reapLine!.message).toMatch(/idle \d+s/);
    expect(reapLine!.message).toContain('pgrep -f');
  });

  it('spares a session whose owning call is recent', async () => {
    const manager = makeManager();
    const { processId, pid } = await spawnSession(
      manager,
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      'live session probe'
    );

    const { log } = collector();
    const result = await sweepExecOrphans(manager, { lifetimeMs: LIFETIME_MS, log, now: Date.now() });

    expect(result.reapedSessions).toBe(0);
    expect(pidAlive(pid)).toBe(true);
    expect(manager.listProcesses().some((entry) => entry.processId === processId)).toBe(true);
    await manager.terminateProcess(processId);
  });

  it('spares a declared-persistent session however old it is', async () => {
    const manager = makeManager();
    const { processId, pid } = await spawnSession(
      manager,
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      'declared persistent server'
    );
    expect(manager.declareSessionPersistent(processId)).toBe(true);
    expect(manager.declareSessionPersistent(999_999_999)).toBe(false);

    const { lines, log } = collector();
    const result = await sweepExecOrphans(manager, { lifetimeMs: LIFETIME_MS, log, now: LONG_AFTER() });

    expect(result.reapedSessions).toBe(0);
    expect(pidAlive(pid)).toBe(true);
    expect(manager.listProcesses().some((entry) => entry.processId === processId)).toBe(true);
    expect(lines.filter((line) => line.level === 'warn')).toEqual([]);
    await manager.terminateProcess(processId);
  });
});

describe.skipIf(!IS_LINUX)('spawn marker', () => {
  it('stamps every session child with an ownership marker its descendants inherit', async () => {
    const manager = makeManager();
    const { processId, pid } = await spawnSession(
      manager,
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      'marker probe'
    );
    await waitFor(
      () => scanMarkedProcesses().some((found) => found.pid === pid && found.marker.processId === processId),
      'the spawned session to appear in the marker scan'
    );
    const found = scanMarkedProcesses().find((candidate) => candidate.pid === pid)!;
    expect(found.marker.ownerPid).toBe(process.pid);
    await manager.terminateProcess(processId);
  });

  it('round-trips and rejects malformed marker values', () => {
    const value = execSpawnMarkerValue(4242);
    const parsed = parseExecSpawnMarker(value);
    expect(parsed).toMatchObject({ ownerPid: process.pid, processId: 4242 });
    expect(parseExecSpawnMarker('')).toBeNull();
    expect(parseExecSpawnMarker('not a marker')).toBeNull();
    expect(parseExecSpawnMarker('1:2')).toBeNull();
    expect(parseExecSpawnMarker('0:aa:5')).toBeNull();
  });
});

describe.skipIf(!IS_LINUX)('escaped-descendant reaping', () => {
  it('reaps a descendant whose session ended longer than the lifetime ago', async () => {
    const manager = makeManager();
    // The session ends (a shell that backgrounded a server and exited); the survivor keeps
    // the session's marker. Ownership of the id is proven through the manager's ledger.
    const processId = manager.allocateProcessId();
    manager.releaseProcessId(processId);
    const pid = await spawnMarkedOrphan(execSpawnMarkerValue(processId));
    await waitFor(() => scanMarkedProcesses().some((found) => found.pid === pid), 'the orphan to be scannable');

    const { lines, log } = collector();
    const result = await sweepExecOrphans(manager, { lifetimeMs: LIFETIME_MS, log, now: LONG_AFTER() });

    expect(result.reapedEscapees).toBeGreaterThanOrEqual(1);
    await waitFor(() => !pidAlive(pid), `escapee pid ${pid} to die`);
    const reapLine = lines.find((line) => line.level === 'warn' && line.message.includes(`pid ${pid}`));
    expect(reapLine).toBeDefined();
    expect(reapLine!.message).toContain('escaped exec descendant');
    expect(reapLine!.message).toContain(`session ${processId}`);
  });

  it('spares a descendant whose session ended within the lifetime', async () => {
    const manager = makeManager();
    const processId = manager.allocateProcessId();
    manager.releaseProcessId(processId);
    const pid = await spawnMarkedOrphan(execSpawnMarkerValue(processId));
    await waitFor(() => scanMarkedProcesses().some((found) => found.pid === pid), 'the orphan to be scannable');

    const { log } = collector();
    await sweepExecOrphans(manager, { lifetimeMs: LIFETIME_MS, log, now: Date.now() });
    expect(pidAlive(pid)).toBe(true);
  });

  it('logs and skips a marked process owned by a different live app process', async () => {
    const manager = makeManager();
    // Foreign run id, owner pid demonstrably alive (it is this test process).
    const pid = await spawnMarkedOrphan(`${process.pid}:aaaabbbbcccc:7777`);
    await waitFor(() => scanMarkedProcesses().some((found) => found.pid === pid), 'the foreign orphan to be scannable');

    const { lines, log } = collector();
    const result = await sweepExecOrphans(manager, { lifetimeMs: LIFETIME_MS, log, now: LONG_AFTER() });

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(pidAlive(pid)).toBe(true);
    expect(lines.some((line) => line.message.includes(`leaving pid ${pid} alone`))).toBe(true);
  });
});

describe.skipIf(!IS_LINUX)('startup sweep', () => {
  it('deliberately reaps leftovers from a previous run whose owner is gone', async () => {
    // The marker names this test process as owner so concurrently running app/test
    // processes correctly leave the fixture alone; the injected liveness check is what
    // makes *this* sweep see that previous run as dead.
    const foreignMarker = `${process.pid}:deadbeefdead:4242`;
    const pid = await spawnMarkedOrphan(foreignMarker);
    await waitFor(() => scanMarkedProcesses().some((found) => found.pid === pid), 'the leftover to be scannable');

    const { lines, log } = collector();
    const result = await startupExecOrphanSweep(makeManager(), {
      log,
      ownerAlive: (ownerPid) => ownerPid !== process.pid
    });

    expect(result.reapedEscapees).toBeGreaterThanOrEqual(1);
    await waitFor(() => !pidAlive(pid), `leftover pid ${pid} to die`);
    const reapLine = lines.find((line) => line.level === 'warn' && line.message.includes(`pid ${pid}`));
    expect(reapLine).toBeDefined();
    expect(reapLine!.message).toContain('previous run');
    expect(lines.some((line) => line.message.includes('startup sweep reaped'))).toBe(true);
  });
});
