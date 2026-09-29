/**
 * The environment marker that makes exec_command descendants attributable.
 *
 * Every unified exec session is spawned with `CLF_EXEC_SPAWN=<ownerPid>:<runId>:<sessionId>`
 * in its environment. Children inherit environment, so every descendant of a session —
 * including a server the shell backgrounded before exiting — carries proof of which app
 * process spawned it, in which run, for which session id. The reaper trusts nothing else:
 * a process without this marker is somebody's work and is never touched, and a process
 * with it is inside the app's own spawn registry by definition.
 *
 * The `CLF_` prefix is reserved by the app (`exec.ts` rejects model-supplied overrides
 * that spell it), so a model cannot forge or clear the marker through the tool surface.
 *
 * `ownerPid` is in the marker so that two live app processes — the desktop app beside the
 * headless daemon, or parallel test workers — can tell each other's children apart: a
 * marker from another run is only reapable once the process that minted it is gone.
 */

import { randomBytes } from 'node:crypto';

export const EXEC_SPAWN_MARKER_ENV = 'CLF_EXEC_SPAWN';

/** This process's run token. A restart mints a new one, which is what makes leftovers visible. */
export const EXEC_RUN_ID = randomBytes(6).toString('hex');

export interface ExecSpawnMarker {
  /** The pid of the app process that spawned the session. */
  readonly ownerPid: number;
  /** The spawning process's `EXEC_RUN_ID`. */
  readonly runId: string;
  /** The unified exec session id (`session_id` in the model contract). */
  readonly processId: number;
}

export function execSpawnMarkerValue(
  processId: number,
  ownerPid: number = process.pid,
  runId: string = EXEC_RUN_ID
): string {
  return `${ownerPid}:${runId}:${processId}`;
}

/** Null for anything that does not parse exactly; a malformed marker proves nothing. */
export function parseExecSpawnMarker(value: string): ExecSpawnMarker | null {
  const match = /^(\d+):([0-9a-f]+):(\d+)$/.exec(value);
  if (!match) return null;
  const ownerPid = Number.parseInt(match[1]!, 10);
  const processId = Number.parseInt(match[3]!, 10);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return null;
  if (!Number.isSafeInteger(processId) || processId <= 0) return null;
  return { ownerPid, runId: match[2]!, processId };
}
