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
  acknowledgeWorkstreamArchiveCleanup,
  bindWorkstreamConversation,
  continueWorkstream,
  finishWorkstreamArchive,
  nextWorkstreamActions,
  noteSuccessfulWorkstreamTool,
  pendingWorkstreamArchives,
  queueFailedBootstrapArchive,
  recordWorkstreamCommand,
  replaceWorkstream,
  reserveWorkstream,
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

    // No-op completed turns must not create an unbounded chain of sends.
    const noOp = await startWorkstream('no-op', path.join(temp, 'one'), 1000);
    assert.equal(noOp.ok, true);
    if (!noOp.ok) throw new Error('unreachable');
    await setWorkstreamAutoAdvance('no-op', true);
    assert.equal(await bindWorkstreamConversation(noOp.workstreamId, 'chat-no-op'), 'no-op');
    assert.equal(await scheduleWorkstreamAfterTurn('chat-no-op', 'turn-empty', 'completed', 2100, 2100), true);
    assert.equal(state('no-op').phase, 'blocked');
    assert.match(state('no-op').error ?? '', /^auto_continue_without_successful_tool:/);
    assert.equal(state('no-op').actionId, null);
    assert.ok(!(await nextWorkstreamActions(2200, true)).some((entry) => entry.id === 'no-op'));
    assert.equal(await scheduleWorkstreamAfterTurn('chat-no-op', 'turn-empty-again', 'completed', 2300, 2300), false);

    // An explicit model reclaim remains available; a genuinely successful call
    // permits exactly one more automatic continuation.
    const reclaimed = await continueWorkstream('no-op', 3000);
    assert.equal(reclaimed.ok, true);
    if (!reclaimed.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(reclaimed.workstreamId, 'chat-no-op'), 'no-op');
    await noteSuccessfulWorkstreamTool('no-op', noOp.workstreamId, 3010); // stale claim
    assert.equal(state('no-op').lastSuccessfulToolAt, 0);
    await noteSuccessfulWorkstreamTool('no-op', reclaimed.workstreamId, 3020);
    assert.equal(await scheduleWorkstreamAfterTurn('chat-no-op', 'turn-real', 'completed', 3100, 3100), true);
    assert.equal(state('no-op').phase, 'advancing');
    const advance = state('no-op').actionId;
    assert.ok(advance);
    assert.equal(await recordWorkstreamCommand('no-op', advance, 'cmd-next'), true);
    assert.equal(await scheduleWorkstreamAfterTurn('chat-no-op', 'turn-after-no-work', 'completed', 3200, 3200), true);
    assert.equal(state('no-op').phase, 'blocked');
    assert.equal(state('no-op').commandId, null);

    // A server conversation allocated by an uncommitted bootstrap is a
    // verifiable orphan. A wrong/stale command cannot nominate one.
    const bootstrap = await reserveWorkstream('orphan', 'fixture', 'cmd-start', true, 4000);
    assert.equal(bootstrap.ok, true);
    assert.equal(await queueFailedBootstrapArchive('orphan', 'wrong-command', 'orphan-chat'), false);
    assert.equal(await queueFailedBootstrapArchive('orphan', 'cmd-start', 'WEB:temporary'), false);
    assert.equal(await queueFailedBootstrapArchive('orphan', 'cmd-start', 'orphan-chat'), true);
    assert.deepEqual(pendingWorkstreamArchives().filter((item) => item.id === 'orphan'),
      [{ id: 'orphan', conversationId: 'orphan-chat' }]);

    // A timed-out archive must release the former owner *and* preserve the
    // unconfirmed backend cleanup until a distinct successor is bound.
    const first = await startWorkstream('replace', path.join(temp, 'two'), 5000);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(first.workstreamId, 'old-chat'), 'replace');
    assert.equal(await replaceWorkstream('replace'), true);
    const archived = state('replace').actionId;
    assert.ok(archived);
    assert.equal(state('replace').phase, 'archiving');
    assert.equal(await finishWorkstreamArchive('replace', archived, 'extension unavailable'), true);
    assert.equal(state('replace').phase, 'opening');
    assert.deepEqual(state('replace').pendingArchives, ['old-chat']);
    assert.ok(!pendingWorkstreamArchives().some((item) => item.id === 'replace'));
    assert.equal(await finishWorkstreamArchive('replace', archived, null), false);

    const successor = await continueWorkstream('replace', 6000);
    assert.equal(successor.ok, true);
    if (!successor.ok) throw new Error('unreachable');
    assert.equal(await bindWorkstreamConversation(successor.workstreamId, 'new-chat'), 'replace');
    assert.deepEqual(pendingWorkstreamArchives().filter((item) => item.id === 'replace'),
      [{ id: 'replace', conversationId: 'old-chat' }]);
    assert.equal(await acknowledgeWorkstreamArchiveCleanup('replace', 'new-chat'), false);
    assert.equal(await acknowledgeWorkstreamArchiveCleanup('replace', 'old-chat'), true);
    assert.deepEqual(state('replace').pendingArchives, []);
    assert.deepEqual(pendingWorkstreamArchives().filter((item) => item.id === 'replace'), []);

    // The browser ACK belongs to the exact orphan and is idempotent. Persist
    // and reload the workstream document to validate the restart boundary.
    const durable = JSON.parse(await readFile(path.join(temp, 'state', 'workstreams.json'), 'utf8'));
    assert.ok(durable.rows.some((row: { id: string; orphanedBootstraps: string[] }) =>
      row.id === 'orphan' && row.orphanedBootstraps.includes('orphan-chat')));
    // Force an actual serialization/parse round trip: a same-root restore
    // would simply reuse the current in-memory map.
    initDurableStore(path.join(temp, 'empty-other-root'));
    await restoreWorkstreams();
    assert.equal(workstreamStatus().length, 0);
    initDurableStore(temp);
    await restoreWorkstreams();
    assert.deepEqual(pendingWorkstreamArchives().filter((item) => item.id === 'orphan'),
      [{ id: 'orphan', conversationId: 'orphan-chat' }]);
    assert.equal(await acknowledgeWorkstreamArchiveCleanup('orphan', 'orphan-chat'), true);
    assert.equal(await acknowledgeWorkstreamArchiveCleanup('orphan', 'orphan-chat'), false);

    console.log('PASS: no-work advancement, stale-claim exclusion, archive timeout, orphan cleanup, durable ACK');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
