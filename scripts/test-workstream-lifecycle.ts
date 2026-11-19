/**
 * Deterministic state-owner regression; the independent live ChatGPT acceptance
 * in live-chatgpt-workstream.mjs covers the browser/extension/backend boundary.
 *
 * Run: npx tsx scripts/test-workstream-lifecycle.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDurableStore } from '../src/main/durable';
import {
  admitWorkstreamCall,
  acknowledgeWorkstreamArchiveCleanup,
  bindWorkstreamConversation,
  completeWorkstreamReplacementReceipt,
  continueWorkstream,
  finishWorkstreamArchive,
  invalidateWorkstreamConversation,
  nextWorkstreamActions,
  noteSuccessfulWorkstreamTool,
  observeWorkstreamTerminalError,
  pendingWorkstreamArchives,
  pauseWorkstream,
  queueFailedBootstrapArchive,
  recordWorkstreamCommand,
  recoverWorkstreamNow,
  replaceWorkstream,
  reserveWorkstream,
  resumeWorkstream,
  restoreWorkstreams,
  scheduleWorkstreamAfterTurn,
  setWorkstreamAutoAdvance,
  startWorkstream,
  workstreamStatus,
} from '../src/main/workstreams';

void (async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'workstream-lifecycle-'));
  try {
    initDurableStore(temp);
    await restoreWorkstreams();
    const state = (id: string) => {
      const row = workstreamStatus().find((entry) => entry.id === id);
      assert.ok(row, `missing workstream ${id}`);
      return row;
    };

    // A terminal, exhausted ChatGPT conversation must not keep its workstream
    // lease merely because its controller entered same-chat recovery first.
    const terminal = await startWorkstream('orchestrator', path.join(temp, 'terminal'), 1000);
    assert.equal(terminal.ok, true);
    if (!terminal.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(terminal.workstreamId, 'chat-terminal'), 'orchestrator');
    assert.equal((await continueWorkstream('orchestrator', 1050)).ok, false);
    assert.equal(await recoverWorkstreamNow('orchestrator', 'attempt same-chat recovery', 1100), true);
    assert.equal(state('orchestrator').phase, 'recovering');
    assert.equal(await scheduleWorkstreamAfterTurn(
      'chat-terminal', 'turn-context-max', 'failed', 1150, 1200, true,
    ), true);
    assert.equal(state('orchestrator').claimReleased, true);
    assert.equal((await admitWorkstreamCall(terminal.workstreamId, 1250)).ok, false);
    const successorToTerminal = await continueWorkstream('orchestrator', 1250);
    assert.equal(successorToTerminal.ok, true);
    // The retired chat's delayed network error cannot fence the new opaque
    // claim while the replacement's browser conversation is still unbound.
    assert.equal(await observeWorkstreamTerminalError(
      'chat-terminal', 'conversation_too_large', 1300), false);
    assert.equal(state('orchestrator').claimReleased, false);
    if (!successorToTerminal.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(successorToTerminal.workstreamId,
      'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd'), 'orchestrator');
    assert.equal(await observeWorkstreamTerminalError(
      'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd', 'conversation_too_large', 1320), true);
    assert.equal(state('orchestrator').claimReleased, true);
    assert.equal((await continueWorkstream('orchestrator', 1330)).ok, true);

    // The backend may reject before ChatGPT renders a turn_start or turn_end.
    // That error must enter replacement from the independent typed transport
    // signal; a human-visible English error alone is not accepted.
    const sse = await startWorkstream('terminal-sse', path.join(temp, 'sse'), 2000);
    assert.equal(sse.ok, true);
    if (!sse.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('terminal-sse', true);
    assert.equal(await bindWorkstreamConversation(sse.workstreamId,
      'abababab-abab-abab-abab-abababababab'), 'terminal-sse');
    assert.equal(await observeWorkstreamTerminalError(
      'abababab-abab-abab-abab-abababababab', 'other_error', 2100), false);
    assert.equal(state('terminal-sse').phase, 'active');
    assert.equal(await observeWorkstreamTerminalError(
      'abababab-abab-abab-abab-abababababab', 'conversation_too_large', 2200), true);
    assert.equal(state('terminal-sse').phase, 'recovering');
    assert.equal(state('terminal-sse').error, 'conversation_too_large');
    await nextWorkstreamActions(2201, true);
    assert.equal(state('terminal-sse').phase, 'archiving');

    // No-op completed turns must not create an unbounded chain of sends.
    const noOp = await startWorkstream('no-op', path.join(temp, 'one'), 1000);
    assert.equal(noOp.ok, true);
    if (!noOp.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('no-op', true);
    assert.equal(await bindWorkstreamConversation(noOp.workstreamId, 'chat-no-op'), 'no-op');
    // A ChatGPT route probe must not erase a current, tool-capable workstream.
    assert.equal(await invalidateWorkstreamConversation('no-op', 'chat-no-op'), false);
    assert.equal(state('no-op').conversationId, 'chat-no-op');
    assert.equal(await scheduleWorkstreamAfterTurn('chat-no-op', 'turn-empty', 'completed', 2100, 2100), true);
    assert.equal(state('no-op').phase, 'active');
    assert.match(state('no-op').error ?? '', /^auto_continue_without_successful_tool:/);
    assert.equal(state('no-op').actionId, null);
    assert.ok(!(await nextWorkstreamActions(2200, true)).some((entry) => entry.id === 'no-op'));
    assert.equal(await scheduleWorkstreamAfterTurn('chat-no-op', 'turn-empty-again', 'completed', 2300, 2300), true);
    assert.equal(state('no-op').phase, 'active');
    assert.equal(state('no-op').actionId, null);

    // A no-work turn must NOT revoke ordinary tool admission. That earlier
    // implementation blocked Sage itself after one text-only response.
    const admitted = await admitWorkstreamCall(noOp.workstreamId, 3000);
    assert.equal(admitted.ok, true);
    // A later legitimate reclaim also remains available after lease expiry.
    const reclaimed = await continueWorkstream('no-op', 400000);
    assert.equal(reclaimed.ok, true);
    if (!reclaimed.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(reclaimed.workstreamId, 'chat-no-op'), 'no-op');
    await noteSuccessfulWorkstreamTool('no-op', noOp.workstreamId, 400010); // stale claim
    assert.equal(state('no-op').lastSuccessfulToolAt, 0);
    await noteSuccessfulWorkstreamTool('no-op', reclaimed.workstreamId, 400020);
    assert.equal(await scheduleWorkstreamAfterTurn('chat-no-op', 'turn-real', 'completed', 400100, 400100), true);
    assert.equal(state('no-op').phase, 'advancing');
    const advance = state('no-op').actionId;
    assert.ok(advance);
    assert.equal(await recordWorkstreamCommand('no-op', advance, 'cmd-next'), true);
    assert.equal(await scheduleWorkstreamAfterTurn('chat-no-op', 'turn-after-no-work', 'completed', 400200, 400200), true);
    assert.equal(state('no-op').phase, 'active');
    assert.equal(state('no-op').commandId, null);

    // A server conversation allocated by an uncommitted bootstrap is a
    // verifiable orphan. A wrong/stale command cannot nominate one.
    const bootstrap = await reserveWorkstream('orphan', 'fixture', 'cmd-start', true, 4000);
    assert.equal(bootstrap.ok, true);
    assert.equal(await queueFailedBootstrapArchive('orphan', 'wrong-command', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), false);
    assert.equal(await queueFailedBootstrapArchive('orphan', 'cmd-start', 'WEB:temporary'), false);
    assert.equal(await queueFailedBootstrapArchive('orphan', 'cmd-start', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), true);
    // A failed ACK does not prove that a new browser chat never started real
    // work. Do not archive it until a different successor is bound.
    assert.ok(!state('orphan').retiredConversations.includes('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
    assert.deepEqual(pendingWorkstreamArchives().filter((item) => item.id === 'orphan'), []);

    // A timed-out archive must release the former owner *and* preserve the
    // unconfirmed backend cleanup until a distinct successor is bound.
    const first = await startWorkstream('replace', path.join(temp, 'two'), 5000);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(first.workstreamId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 'replace');
    assert.equal(await replaceWorkstream('replace'), true);
    const archived = state('replace').actionId;
    assert.ok(archived);
    assert.equal(state('replace').phase, 'archiving');
    assert.equal(await finishWorkstreamArchive('replace', archived, 'extension unavailable'), true);
    assert.equal(state('replace').phase, 'opening');
    assert.deepEqual(state('replace').pendingArchives, ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']);
    assert.ok(!pendingWorkstreamArchives().some((item) => item.id === 'replace'));
    assert.equal(await finishWorkstreamArchive('replace', archived, null), false);

    const successor = await continueWorkstream('replace', 6000);
    assert.equal(successor.ok, true);
    if (!successor.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(successor.workstreamId, 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 'replace');
    assert.deepEqual(pendingWorkstreamArchives().filter((item) => item.id === 'replace'),
      [{ id: 'replace', conversationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }]);
    assert.equal(await acknowledgeWorkstreamArchiveCleanup('replace', 'cccccccc-cccc-cccc-cccc-cccccccccccc'), false);
    assert.equal(await acknowledgeWorkstreamArchiveCleanup('replace', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), true);
    assert.deepEqual(state('replace').pendingArchives, []);

    // A successor can finish its first *successful* turn before the browser
    // acknowledges its opening send. The exact opening command must survive
    // that turn and become ACK-able; only then may the queued advance run.
    const overlapping = await startWorkstream('overlapping-ack', path.join(temp, 'overlap'), 100_000);
    assert.equal(overlapping.ok, true);
    if (!overlapping.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('overlapping-ack', true);
    assert.equal(await bindWorkstreamConversation(overlapping.workstreamId, '11111111-1111-1111-1111-111111111111'), 'overlapping-ack');
    assert.equal(await replaceWorkstream('overlapping-ack'), true);
    const archiveAction = state('overlapping-ack').actionId;
    assert.ok(archiveAction);
    assert.equal(await finishWorkstreamArchive('overlapping-ack', archiveAction, null), true);
    const bootstrapAction = state('overlapping-ack').actionId;
    assert.ok(bootstrapAction);
    assert.equal(await recordWorkstreamCommand('overlapping-ack', bootstrapAction, 'cmd-overlap'), true);
    const attached = await continueWorkstream('overlapping-ack', 120_000);
    assert.equal(attached.ok, true);
    if (!attached.ok) throw new Error('unreachable');
    assert.equal(state('overlapping-ack').commandId, 'cmd-overlap');
    assert.equal(state('overlapping-ack').conversationId, null);
    assert.equal(await scheduleWorkstreamAfterTurn(
      '11111111-1111-1111-1111-111111111111', 'old-turn', 'completed', 120_010, 120_010,
    ), false);
    assert.equal(state('overlapping-ack').commandId, 'cmd-overlap');
    const successorChat = '22222222-2222-2222-2222-222222222222';
    assert.equal(await bindWorkstreamConversation(attached.workstreamId, successorChat), 'overlapping-ack');
    await noteSuccessfulWorkstreamTool('overlapping-ack', attached.workstreamId, 120_020);
    assert.equal(await scheduleWorkstreamAfterTurn(
      successorChat, 'new-turn', 'completed', 120_030, 120_030,
    ), true);
    assert.equal(state('overlapping-ack').phase, 'advancing');
    assert.equal(state('overlapping-ack').commandId, 'cmd-overlap');
    assert.equal(await completeWorkstreamReplacementReceipt('cmd-overlap', successorChat), true);
    assert.equal(state('overlapping-ack').commandId, null);
    assert.equal(state('overlapping-ack').phase, 'advancing');
    assert.ok(state('overlapping-ack').actionId?.startsWith('advance-'));
    assert.deepEqual(pendingWorkstreamArchives().filter((item) => item.id === 'replace'), []);

    // The browser ACK belongs to the exact orphan and is idempotent. Persist
    // and reload the workstream document to validate the restart boundary.
    const durable = JSON.parse(await readFile(path.join(temp, 'state', 'workstreams.json'), 'utf8'));
    assert.ok(durable.rows.some((row: { id: string; orphanedBootstraps: string[] }) =>
      row.id === 'orphan' && row.orphanedBootstraps.includes('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')));
    // Force an actual serialization/parse round trip: a same-root restore
    // would simply reuse the current in-memory map.
    initDurableStore(path.join(temp, 'empty-other-root'));
    await restoreWorkstreams();
    assert.equal(workstreamStatus().length, 0);
    initDurableStore(temp);
    await restoreWorkstreams();
    assert.deepEqual(pendingWorkstreamArchives().filter((item) => item.id === 'orphan'), []);
    const orphanSuccessor = await continueWorkstream('orphan', 500000);
    assert.equal(orphanSuccessor.ok, true);
    if (!orphanSuccessor.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(orphanSuccessor.workstreamId, 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'orphan');
    assert.ok(state('orphan').retiredConversations.includes('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
    assert.deepEqual(pendingWorkstreamArchives().filter((item) => item.id === 'orphan'),
      [{ id: 'orphan', conversationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }]);
    assert.equal(await acknowledgeWorkstreamArchiveCleanup('orphan', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), true);
    assert.equal(await acknowledgeWorkstreamArchiveCleanup('orphan', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), false);

    // A late successful ACK can identify the very chat previously thought
    // orphaned. Never retire or archive it in that case.
    const late = await reserveWorkstream('late-ack', 'fixture', 'cmd-late', true, 510000);
    assert.equal(late.ok, true);
    assert.equal(await queueFailedBootstrapArchive('late-ack', 'cmd-late', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), true);
    const claimedLate = await continueWorkstream('late-ack', 520000);
    assert.equal(claimedLate.ok, true);
    if (!claimedLate.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(claimedLate.workstreamId, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 'late-ack');
    assert.deepEqual(state('late-ack').pendingArchives, []);
    assert.ok(!state('late-ack').retiredConversations.includes('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'));

    // The inactive case still permits an explicit stale-route invalidation.
    const parked = await startWorkstream('parked', path.join(temp, 'parked'), 530000);
    assert.equal(parked.ok, true);
    if (!parked.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(parked.workstreamId, 'ffffffff-ffff-ffff-ffff-ffffffffffff'), 'parked');
    assert.equal(await pauseWorkstream('parked'), true);
    assert.equal(await invalidateWorkstreamConversation('parked', 'ffffffff-ffff-ffff-ffff-ffffffffffff'), true);
    assert.equal(state('parked').conversationId, null);
    assert.ok(state('parked').retiredConversations.includes('ffffffff-ffff-ffff-ffff-ffffffffffff'));
    assert.equal(await resumeWorkstream('parked'), true);
    assert.equal(await recoverWorkstreamNow('parked', 'verified old chat', 540000), false);
    assert.equal(await recoverWorkstreamNow('parked', 'verified old chat', 540000, undefined,
      'abababab-abab-abab-abab-abababababab'), false);
    assert.equal(await recoverWorkstreamNow('parked', 'verified old chat', 540000, undefined,
      'ffffffff-ffff-ffff-ffff-ffffffffffff'), true);
    assert.equal(state('parked').phase, 'recovering');
    assert.equal(state('parked').conversationId, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
    assert.ok(!state('parked').retiredConversations.includes('ffffffff-ffff-ffff-ffff-ffffffffffff'));

    console.log('PASS: no-work advancement, stale-claim exclusion, archive timeout, orphan cleanup, durable ACK');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
