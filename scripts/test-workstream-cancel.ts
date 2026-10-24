/** Executable focused runtime check: cancellation ends the precise owned child. */
import assert from 'node:assert/strict';
import {
  cancelOverlongTerminalCalls,
  emptyEvidence,
  runInCallContext,
  runningToolCallsForWorkstream,
  trackInFlight,
  type CallContext
} from '../src/main/mcp/call-context.js';
import { UnifiedExecProcessManager } from '../src/main/codex/unified-exec.js';

async function verifyCancellation(): Promise<void> {
  const manager = new UnifiedExecProcessManager(300_000);
  const processId = manager.allocateProcessId();
  const id = 'watchdog-test-not-a-real-workstream';
  const call: CallContext = {
    startedAt: Date.now() - 360_000,
    tool: 'exec_command',
    workstreamId: id,
    workstreamClaimId: 'test-only',
    workstreamSessionId: null,
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId: null, conversationId: null },
    outcome: null,
    evidence: emptyEvidence(),
    cancellation: new AbortController(),
  };
  const work = trackInFlight(call, () =>
    runInCallContext(call, () =>
      manager.execCommand({
        command: ['/bin/sh', '-c', 'sleep 8'],
        shellType: 'bash',
        hookCommand: 'sleep 8',
        processId,
        yieldTimeMs: 30_000,
        maxOutputTokens: 500,
        truncationPolicy: { kind: 'tokens', tokens: 500 },
        cwd: process.cwd(),
        displayCwd: process.cwd(),
        env: process.env,
        tty: false,
        cancelSignal: call.cancellation.signal,
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(runningToolCallsForWorkstream(id), 1);
  const cancellation = cancelOverlongTerminalCalls(id, 300_000);
  assert.equal(cancellation.requested, 1);
  await Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Cancellation did not settle the call')), 3000),
    ),
  ]);
  assert.equal(runningToolCallsForWorkstream(id), 0);
  assert.equal(cancelOverlongTerminalCalls(id, 300_000).requested, 0);
  process.stdout.write('Targeted terminal cancellation settled its MCP call.\n');
}

void verifyCancellation().catch((error: unknown) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
