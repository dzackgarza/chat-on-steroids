/**
 * The exec orphan reaper.
 *
 * At the 2026-09-09 daemon restart the app's cgroup held 52 processes — ~40 orphaned
 * exec_command wait-loops (several of them `pgrep -f` loops matching their own command
 * line, structurally unable to exit) and about a dozen stranded pandoc servers — at 6.0 G
 * peak memory on a 7 GB box. Nothing reaped them while the daemon ran; the restart cleared
 * them only as an accident of cgroup teardown. `docs/exec-orphan-audit-2026-09-09.md` is
 * the defect record. This module makes both cleanups deliberate:
 *
 *  - **Periodic sweep.** Every session in the unified exec manager whose owning tool call
 *    ended more than a bounded lifetime ago is killed as a whole process tree, unless the
 *    session was declared persistent (`declareSessionPersistent`). A `pgrep` self-loop is
 *    subsumed: its owning call ended long ago, so the lifetime bound reaps it without any
 *    pattern inspection.
 *  - **Escapee sweep** (Linux). Descendants that outlived their session — the shell exited,
 *    the backgrounded server did not — are found through the `CLF_EXEC_SPAWN` marker every
 *    spawn injects (see exec-spawn-marker.ts) and killed once their session's end is older
 *    than the same lifetime.
 *  - **Startup sweep.** On boot the same marker scan reaps leftovers from a previous run:
 *    a marker minted by a different run whose owner process is gone.
 *
 * Ownership discipline: only processes carrying the app's own marker are ever signalled,
 * and a marker whose minting process is still alive belongs to that process — logged and
 * skipped, never killed. Every reap is logged at warn level with pid, age and command
 * line. No silent kills, no heuristics about what "looks" orphaned.
 *
 * Config (environment, read at start):
 *   COS_EXEC_REAP_INTERVAL_MS    sweep cadence; 0 disables the periodic sweep (default 10 min)
 *   COS_EXEC_ORPHAN_LIFETIME_MS  how long past its owning call a process may live (default 10 min)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { logInfo, logWarn } from './logger.js';
import { EXEC_RUN_ID, EXEC_SPAWN_MARKER_ENV, parseExecSpawnMarker, type ExecSpawnMarker } from './exec-spawn-marker.js';
import type { UnifiedExecProcessManager } from './codex/unified-exec.js';

export const DEFAULT_EXEC_REAP_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_EXEC_ORPHAN_LIFETIME_MS = 10 * 60_000;
/** Floor on the configurable lifetime, so a typo cannot reap a session mid-command. */
export const MIN_EXEC_ORPHAN_LIFETIME_MS = 60_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function configuredReapIntervalMs(): number {
  return envMs('COS_EXEC_REAP_INTERVAL_MS', DEFAULT_EXEC_REAP_INTERVAL_MS);
}

export function configuredOrphanLifetimeMs(): number {
  const value = envMs('COS_EXEC_ORPHAN_LIFETIME_MS', DEFAULT_EXEC_ORPHAN_LIFETIME_MS);
  return Math.max(MIN_EXEC_ORPHAN_LIFETIME_MS, value);
}

// --------------------------------------------------------------------------- /proc scan

export interface MarkedProcess {
  pid: number;
  marker: ExecSpawnMarker;
  commandLine: string;
  /** The process group, from /proc/<pid>/stat, or null when unreadable. */
  pgid: number | null;
  /** Seconds since the process started, or null when unreadable. */
  ageSeconds: number | null;
}

function readProcFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** pgrp and starttime out of /proc/<pid>/stat, parsed from after the `(comm)` field. */
function readStat(pid: number): { pgid: number | null; startTicks: number | null } {
  const stat = readProcFile(`/proc/${pid}/stat`);
  if (!stat) return { pgid: null, startTicks: null };
  const close = stat.lastIndexOf(')');
  if (close === -1) return { pgid: null, startTicks: null };
  // Fields after the comm: state ppid pgrp session tty tpgid flags minflt ... — pgrp is
  // index 2 and starttime index 19 of this remainder (stat fields 5 and 22).
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const pgid = Number.parseInt(fields[2] ?? '', 10);
  const startTicks = Number.parseInt(fields[19] ?? '', 10);
  return {
    pgid: Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null,
    startTicks: Number.isSafeInteger(startTicks) && startTicks >= 0 ? startTicks : null
  };
}

function uptimeSeconds(): number | null {
  const raw = readProcFile('/proc/uptime');
  const value = raw === null ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/** Linux USER_HZ is 100 on every supported platform; fine for a log line's age. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Every process this user can inspect that carries the app's spawn marker.
 *
 * Returns an empty list where /proc does not exist (Windows, macOS); the registry-based
 * periodic sweep still covers those platforms, because the manager kills by pid/taskkill.
 */
export function scanMarkedProcesses(): MarkedProcess[] {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const uptime = uptimeSeconds();
  const found: MarkedProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (pid === process.pid) continue;
    const environ = readProcFile(`/proc/${pid}/environ`);
    if (!environ) continue;
    let markerValue: string | null = null;
    for (const pair of environ.split('\0')) {
      if (pair.startsWith(`${EXEC_SPAWN_MARKER_ENV}=`)) {
        markerValue = pair.slice(EXEC_SPAWN_MARKER_ENV.length + 1);
        break;
      }
    }
    if (markerValue === null) continue;
    const marker = parseExecSpawnMarker(markerValue);
    if (!marker) continue;
    const commandLine =
      readProcFile(`/proc/${pid}/cmdline`)?.split('\0').filter(Boolean).join(' ').trim() ||
      readProcFile(`/proc/${pid}/comm`)?.trim() ||
      '(unknown command)';
    const { pgid, startTicks } = readStat(pid);
    const ageSeconds =
      uptime !== null && startTicks !== null ? Math.max(0, uptime - startTicks / CLOCK_TICKS_PER_SECOND) : null;
    found.push({ pid, marker, commandLine, pgid, ageSeconds });
  }
  return found;
}

// --------------------------------------------------------------------------- killing

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but is not ours — alive, and decisively not reapable.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** This process's own group, so an escapee kill can never signal the app itself. */
function ownPgid(): number | null {
  return readStat(process.pid).pgid;
}

/**
 * Kills an escaped descendant and its group.
 *
 * An escapee is usually *not* its own group leader — its group is the dead session
 * leader's — so `terminateProcessTree`'s `kill(-pid)` would miss its siblings. The group
 * read from /proc is the tree that matters: it was created by the session's detached
 * spawn, so everything in it is the app's own offspring.
 */
function killEscapee(pid: number, pgid: number | null): void {
  if (pgid !== null && pgid > 1 && pgid !== ownPgid()) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

// --------------------------------------------------------------------------- sweeps

export interface SweepResult {
  reapedSessions: number;
  reapedEscapees: number;
  skipped: number;
}

interface Log {
  info: (message: string) => void;
  warn: (message: string) => void;
}

const defaultLog: Log = { info: logInfo, warn: logWarn };

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** Foreign-owner skips already reported, so a live neighbour is not re-logged every tick. */
const reportedForeignSkips = new Set<number>();

export interface SweepOptions {
  lifetimeMs?: number;
  log?: Log;
  /** Injectable clock, so tests can age sessions without waiting the lifetime out. */
  now?: number;
  /** Injectable owner-liveness check, so tests can fabricate a dead previous run safely. */
  ownerAlive?: (pid: number) => boolean;
}

/** One full reaper pass: aged registry sessions first, then escaped descendants. */
export async function sweepExecOrphans(
  manager: UnifiedExecProcessManager,
  options: SweepOptions = {}
): Promise<SweepResult> {
  const lifetimeMs = options.lifetimeMs ?? configuredOrphanLifetimeMs();
  const log = options.log ?? defaultLog;
  const now = options.now ?? Date.now();
  const ownerAlive = options.ownerAlive ?? pidAlive;
  const result: SweepResult = { reapedSessions: 0, reapedEscapees: 0, skipped: 0 };

  const reaped = await manager.reapIdleSessions(lifetimeMs, now);
  for (const session of reaped) {
    result.reapedSessions += 1;
    log.warn(
      `exec reaper: killed orphaned exec session ${session.processId} ` +
        `(pid ${session.pid}, idle ${seconds(session.idleMs)} > lifetime ${seconds(lifetimeMs)}, ` +
        `tty=${session.tty}, cwd ${session.cwd}, command: ${session.command})`
    );
  }

  for (const escapee of scanMarkedProcesses()) {
    const { pid, marker, commandLine } = escapee;
    const age = escapee.ageSeconds === null ? 'unknown age' : `age ${Math.round(escapee.ageSeconds)}s`;
    if (marker.runId !== EXEC_RUN_ID || marker.ownerPid !== process.pid) {
      // Another run's spawn. Reapable only once the process that minted the marker is
      // gone; while it lives, the process is that run's business, not this one's.
      if (ownerAlive(marker.ownerPid)) {
        result.skipped += 1;
        if (!reportedForeignSkips.has(pid)) {
          reportedForeignSkips.add(pid);
          log.info(
            `exec reaper: leaving pid ${pid} alone — owned by live app process ${marker.ownerPid} (command: ${commandLine})`
          );
        }
        continue;
      }
      killEscapee(pid, escapee.pgid);
      result.reapedEscapees += 1;
      log.warn(
        `exec reaper: killed leftover exec descendant pid ${pid} from a previous run ` +
          `(owner pid ${marker.ownerPid} is gone, session ${marker.processId}, ${age}, command: ${commandLine})`
      );
      continue;
    }
    const disposition = manager.sessionDisposition(marker.processId);
    if (disposition.kind === 'active') continue;
    if (disposition.kind === 'ended' && now - disposition.endedAt <= lifetimeMs) continue;
    const endedNote =
      disposition.kind === 'ended'
        ? `session ${marker.processId} ended ${seconds(now - disposition.endedAt)} ago`
        : `session ${marker.processId} ended beyond the ledger`;
    killEscapee(pid, escapee.pgid);
    result.reapedEscapees += 1;
    log.warn(
      `exec reaper: killed escaped exec descendant pid ${pid} (${endedNote} > lifetime ${seconds(lifetimeMs)}, ` +
        `${age}, command: ${commandLine})`
    );
  }

  return result;
}

/**
 * The boot-time sweep: reap what a previous run left behind, deliberately and logged,
 * instead of relying on cgroup teardown to have happened to clean it.
 *
 * No current-run marker can exist yet, so this is exactly the foreign-marker policy of
 * the periodic sweep; sharing the implementation keeps the two from drifting apart.
 */
export async function startupExecOrphanSweep(
  manager: UnifiedExecProcessManager,
  options: SweepOptions = {}
): Promise<SweepResult> {
  const log = options.log ?? defaultLog;
  // Lifetime 0 with a fresh manager: nothing is registered, nothing current-run exists,
  // so only the previous-run branch can act — and it must act regardless of age.
  const result = await sweepExecOrphans(manager, { ...options, lifetimeMs: 0 });
  if (result.reapedEscapees > 0) {
    log.warn(`exec reaper: startup sweep reaped ${result.reapedEscapees} leftover process(es) from a previous run`);
  } else {
    log.info('exec reaper: startup sweep found no leftover exec processes');
  }
  return result;
}

// --------------------------------------------------------------------------- lifecycle

let reaperTimer: NodeJS.Timeout | null = null;
let sweepInFlight = false;

/**
 * Starts the reaper: one startup sweep now, then the periodic sweep on its interval.
 *
 * Idempotent; the timer is unref'd so it never keeps the process alive, and its shutdown
 * owner is `stopExecReaper` (wired into the process-cleanup phase of both teardown paths,
 * desktop index.ts and headless.ts, right before `terminateAllProcesses` empties its subject).
 */
export function startExecReaper(manager: UnifiedExecProcessManager): void {
  if (reaperTimer) return;
  void startupExecOrphanSweep(manager).catch((error) => {
    logWarn(`exec reaper: startup sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const intervalMs = configuredReapIntervalMs();
  if (intervalMs === 0) {
    logInfo('exec reaper: periodic sweep disabled (COS_EXEC_REAP_INTERVAL_MS=0)');
    return;
  }
  const lifetimeMs = configuredOrphanLifetimeMs();
  reaperTimer = setInterval(() => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void sweepExecOrphans(manager, { lifetimeMs })
      .catch((error) => {
        logWarn(`exec reaper: sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        sweepInFlight = false;
      });
  }, intervalMs);
  reaperTimer.unref?.();
  logInfo(`exec reaper: sweeping every ${seconds(intervalMs)}, orphan lifetime ${seconds(lifetimeMs)}`);
}

export function stopExecReaper(): void {
  if (reaperTimer) clearInterval(reaperTimer);
  reaperTimer = null;
}
