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
  prepareArchivedWorkstreamRecovery,
  queueFailedBootstrapArchive,
  recordWorkstreamCommand,
  releaseFailedWorkstreamDelivery,
  recoverWorkstreamNow,
  replaceWorkstream,
  reserveWorkstream,
  resumeWorkstream,
  restoreWorkstreams,
  scheduleWorkstreamAfterTurn,
  setWorkstreamAutoAdvance,
  terminalizeUnboundWorkstreamClaimant,
  WORKSTREAM_LEASE_MS,
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

    // Archived is not terminal: reserve the exact previously claimed chat,
    // wait for a browser-verified unarchive, then send recovery to that SAME
    // conversation. No new frontend or lease-based replacement may be queued.
    const archivedFixture = await startWorkstream('archived-recovery', path.join(temp, 'archived'), 6000);
    assert.equal(archivedFixture.ok, true);
    if (!archivedFixture.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('archived-recovery', true);
    const archivedChat = '12121212-1212-1212-1212-121212121212';
    assert.equal(await bindWorkstreamConversation(archivedFixture.workstreamId, archivedChat), 'archived-recovery');
    const archivedClaim = await continueWorkstream('archived-recovery', 400_000);
    assert.equal(archivedClaim.ok, true);
    assert.equal(state('archived-recovery').conversationId, null);
    assert.equal(await prepareArchivedWorkstreamRecovery('archived-recovery', archivedChat, 399_999), false);
    assert.equal(await prepareArchivedWorkstreamRecovery('archived-recovery', archivedChat, 400_000), true);
    assert.equal(state('archived-recovery').phase, 'blocked');
    assert.equal(state('archived-recovery').error, 'archived_claimant_restoration_pending');
    assert.ok(!(await nextWorkstreamActions(400_100, true)).some((row) => row.id === 'archived-recovery'));
    assert.equal(await recoverWorkstreamNow('archived-recovery', 'verified unarchive', 400_200,
      { conversationId: null, lastActivity: 400_000 }, archivedChat), true);
    assert.equal(state('archived-recovery').conversationId, archivedChat);
    assert.equal(state('archived-recovery').phase, 'recovering');

    // A newer claim fences an older archive-restoration response even if the
    // earlier claimant's original browser page still exists.
    const stale = await startWorkstream('stale-archive', path.join(temp, 'stale-archive'), 7000);
    assert.equal(stale.ok, true);
    if (!stale.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('stale-archive', true);
    const staleChat = '34343434-3434-3434-3434-343434343434';
    await bindWorkstreamConversation(stale.workstreamId, staleChat);
    assert.equal((await continueWorkstream('stale-archive', 410_000)).ok, true);
    assert.equal(await prepareArchivedWorkstreamRecovery('stale-archive', staleChat, 410_000), true);
    assert.equal((await continueWorkstream('stale-archive', 410_100)).ok, true);
    assert.equal(await prepareArchivedWorkstreamRecovery('stale-archive', staleChat, 410_000), false);
    assert.equal(await recoverWorkstreamNow('stale-archive', 'late browser receipt', 410_200,
      { conversationId: null, lastActivity: 410_000 }, staleChat), false);
    assert.equal(state('stale-archive').conversationId, null);

    // The authenticated backend can instead prove the original chat is
    // terminal, before the page loads. The exact error code bypasses the
    // revive attempt and lease wait, and enters the existing fresh-chat
    // bootstrap without ever misclassifying mere archived/404 state.
    const terminalUnbound = await startWorkstream(
      'terminal-unbound', path.join(temp, 'terminal-unbound'), 8500);
    assert.equal(terminalUnbound.ok, true);
    if (!terminalUnbound.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('terminal-unbound', true);
    const terminalChat = '56565656-5656-5656-5656-565656565656';
    await bindWorkstreamConversation(terminalUnbound.workstreamId, terminalChat);
    assert.equal((await continueWorkstream('terminal-unbound', 500_000)).ok, true);
    assert.equal(await terminalizeUnboundWorkstreamClaimant(
      'terminal-unbound', terminalChat, 500_000, 'conversation_inaccessible'), false);
    assert.equal(state('terminal-unbound').phase, 'active');
    assert.equal(await terminalizeUnboundWorkstreamClaimant(
      'terminal-unbound', terminalChat, 500_000, 'conversation_length_exceeds_limit'), true);
    assert.equal(state('terminal-unbound').phase, 'opening');
    assert.match(state('terminal-unbound').actionId ?? '', /^replace-wl_/);
    assert.ok(state('terminal-unbound').retiredConversations.includes(terminalChat));

    const beforeOrchestratorTerminal = state('orchestrator');
    assert.equal(await terminalizeUnboundWorkstreamClaimant(
      'orchestrator', beforeOrchestratorTerminal.claimedBy.at(-1)!,
      beforeOrchestratorTerminal.lastActivity, 'conversation_length_exceeds_limit'), true);
    assert.equal(state('orchestrator').claimReleased, true);
    assert.equal((await continueWorkstream('orchestrator',
      beforeOrchestratorTerminal.lastActivity + 1)).ok, true);

    // One failed page delivery is not proof of an unusable original chat.
    // Two distinct failed command receipts do establish the same-chat
    // browser route cannot currently accept work. This must not loop forever
    // by decrementing the only recovery-attempt counter each time.
    const unavailable = await startWorkstream('unavailable-chat', path.join(temp, 'unavailable'), 9000);
    assert.equal(unavailable.ok, true);
    if (!unavailable.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('unavailable-chat', true);
    assert.equal(await bindWorkstreamConversation(unavailable.workstreamId,
      '78787878-7878-7878-7878-787878787878'), 'unavailable-chat');
    assert.equal(await recoverWorkstreamNow('unavailable-chat', 'stalled browser', 10000), true);
    await nextWorkstreamActions(10000, true);
    const firstAction = state('unavailable-chat').actionId!;
    assert.equal(await recordWorkstreamCommand('unavailable-chat', firstAction, 'command-one'), true);
    assert.equal(await releaseFailedWorkstreamDelivery('unavailable-chat', firstAction,
      'command-one', 10100, true), true);
    assert.equal(state('unavailable-chat').error, 'revive_browser_delivery_failed_once');
    assert.equal(state('unavailable-chat').phase, 'recovering');
    await nextWorkstreamActions(10100 + 30000, true);
    const secondAction = state('unavailable-chat').actionId!;
    // The logical revive nonce may stay the same across a delivery retry;
    // the two independent browser commands have distinct command IDs.
    assert.equal(firstAction, secondAction);
    assert.equal(await recordWorkstreamCommand('unavailable-chat', secondAction, 'command-two'), true);
    assert.equal(await releaseFailedWorkstreamDelivery('unavailable-chat', secondAction,
      'command-two', 40200, true), true);
    assert.match(state('unavailable-chat').error ?? '', /^revive_browser_delivery_exhausted:/);
    await nextWorkstreamActions(40201, true);
    assert.equal(state('unavailable-chat').phase, 'archiving');

    // A lost command/receipt is not a second failed browser observation.
    const uncertain = await startWorkstream('uncertain-chat', path.join(temp, 'uncertain'), 11000);
    assert.equal(uncertain.ok, true);
    if (!uncertain.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('uncertain-chat', true);
    await bindWorkstreamConversation(uncertain.workstreamId, '90909090-9090-9090-9090-909090909090');
    await recoverWorkstreamNow('uncertain-chat', 'stalled browser', 12000);
    await nextWorkstreamActions(12000, true);
    const uncertainFirstAction = state('uncertain-chat').actionId!;
    await recordWorkstreamCommand('uncertain-chat', uncertainFirstAction, 'uncertain-first');
    await releaseFailedWorkstreamDelivery('uncertain-chat', uncertainFirstAction,
      'uncertain-first', 12100, true);
    await nextWorkstreamActions(42101, true);
    const uncertainNextAction = state('uncertain-chat').actionId!;
    await recordWorkstreamCommand('uncertain-chat', uncertainNextAction, 'uncertain-next');
    await releaseFailedWorkstreamDelivery('uncertain-chat', uncertainNextAction,
      'uncertain-next', 42200, false);
    assert.equal(state('uncertain-chat').phase, 'recovering');
    assert.match(state('uncertain-chat').error ?? '', /^revive_transport_uncertain:/);

    // The claim-line provenance belongs to ONE opaque lock, not merely the
    // historic tail of claimedBy. Typed terminality must be actionable before
    // lease expiry for that current claimant, but a newly rotated lock must
    // never be retired by the previous chat's delayed HTTP 413.
    const realNow = Date.now();
    const proven = await startWorkstream('early-terminal', path.join(temp, 'early-terminal'), realNow);
    assert.equal(proven.ok, true);
    if (!proven.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('early-terminal', true);
    const provenChat = '10101010-1010-1010-1010-101010101010';
    await bindWorkstreamConversation(proven.workstreamId, provenChat);
    assert.equal(state('early-terminal').currentClaimant, provenChat);
    await pauseWorkstream('early-terminal');
    assert.equal(await invalidateWorkstreamConversation('early-terminal', provenChat), true);
    await resumeWorkstream('early-terminal');
    assert.equal(state('early-terminal').conversationId, null);
    assert.equal(await terminalizeUnboundWorkstreamClaimant(
      'early-terminal', provenChat, realNow, 'conversation_length_exceeds_limit'), true);
    assert.equal(state('early-terminal').phase, 'opening');

    const rotated = await startWorkstream('rotated-claim', path.join(temp, 'rotated'), realNow);
    assert.equal(rotated.ok, true);
    if (!rotated.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('rotated-claim', true);
    const oldChat = '20202020-2020-2020-2020-202020202020';
    await bindWorkstreamConversation(rotated.workstreamId, oldChat);
    const newClaim = await continueWorkstream('rotated-claim', realNow + WORKSTREAM_LEASE_MS + 1);
    assert.equal(newClaim.ok, true);
    assert.equal(state('rotated-claim').currentClaimant, null);
    assert.equal(state('rotated-claim').claimedBy.at(-1), oldChat);
    assert.equal(await terminalizeUnboundWorkstreamClaimant(
      'rotated-claim', oldChat, realNow + WORKSTREAM_LEASE_MS + 1,
      'conversation_length_exceeds_limit'), false);
    assert.equal(state('rotated-claim').phase, 'active');

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
