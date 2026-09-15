/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../../../automations/common/automationStorageService.js';
import { TaskTrigger } from '../../common/inboxOneStateMachine.js';
import { INewTaskInit, TransitionOutcome } from '../../common/inboxOneStore.js';
import { AttemptTrigger, EvidenceRung, EventSource, GestureKind, IIngressEvent, LogicalTaskState } from '../../common/inboxOneTypes.js';
import { InboxOneStore } from '../../browser/inboxOneStore.js';

class InMemoryCasStorage implements IAutomationStorageService {
	declare readonly _serviceBrand: undefined;
	private readonly map = new Map<string, string>();

	async read(key: string): Promise<string | undefined> {
		return this.map.get(key);
	}

	async compareAndSwap(key: string, expectedValue: string | undefined, newValue: string): Promise<IAutomationStorageCompareAndSwapResult> {
		const current = this.map.get(key);
		if (current === expectedValue) {
			this.map.set(key, newValue);
			return { swapped: true, currentValue: newValue };
		}
		return { swapped: false, currentValue: current };
	}
}

function sourceEvent(deliveryId = 'd1'): IIngressEvent {
	return { deliveryId, source: EventSource.World, repo: 'acme/api', type: 'pull_request', action: 'opened', subject: { kind: 'pr', id: '842' }, receivedAt: 0 };
}

function init(groupKey = 'acme/api:pr:842'): INewTaskInit {
	return { inboxId: 'my', repo: 'acme/api', groupKey, sourceEvent: sourceEvent(), type: 'code-review', firstAttemptTrigger: AttemptTrigger.Hook };
}

suite('Inbox One - InboxOneStore', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createStore(): InboxOneStore {
		return disposables.add(new InboxOneStore(new InMemoryCasStorage()));
	}

	test('upsertByGroupKey creates a Cooking task with one running attempt', async () => {
		const store = createStore();
		const { task, created } = await store.upsertByGroupKey(init());
		assert.strictEqual(created, true);
		assert.strictEqual(task.state, LogicalTaskState.Cooking);
		assert.strictEqual(task.attempts.length, 1);
		assert.strictEqual(task.currentAttempt, 0);
		assert.strictEqual(task.groupKey, 'acme/api:pr:842');
		assert.ok(task.route.includes(task.id));
	});

	test('upsertByGroupKey is idempotent: a later event joins the same task (I1)', async () => {
		const store = createStore();
		const first = await store.upsertByGroupKey(init());
		const second = await store.upsertByGroupKey(init());
		assert.strictEqual(second.created, false);
		assert.strictEqual(second.task.id, first.task.id);
		assert.strictEqual(store.tasks.get().length, 1);
	});

	test('distinct group keys create distinct tasks', async () => {
		const store = createStore();
		await store.upsertByGroupKey(init('acme/api:pr:842'));
		await store.upsertByGroupKey(init('acme/api:pr:843'));
		assert.strictEqual(store.tasks.get().length, 2);
	});

	test('legal transition applies and updates the observable', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		const res = await store.transition(task.id, TaskTrigger.EvidenceAssembled, { tier: undefined });
		assert.strictEqual(res.outcome, TransitionOutcome.Applied);
		assert.strictEqual(res.task!.state, LogicalTaskState.Decision);
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Decision);
	});

	test('illegal transition is rejected without mutating', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		const res = await store.transition(task.id, TaskTrigger.Accept);
		assert.strictEqual(res.outcome, TransitionOutcome.IllegalTransition);
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Cooking);
	});

	test('transition on unknown task returns NotFound', async () => {
		const store = createStore();
		const res = await store.transition('nope', TaskTrigger.EvidenceAssembled);
		assert.strictEqual(res.outcome, TransitionOutcome.NotFound);
	});

	test('Steer opens a new attempt and marks prior evidence historical (I6)', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		await store.setEvidence(task.id, {
			decisionSentence: 'PR is ready to approve',
			claims: [{ text: '47/47 checks pass', rung: EvidenceRung.SingleRun }],
			gapLine: 'behavior under load not verified',
			freshness: { computedAt: 1 },
		});
		await store.transition(task.id, TaskTrigger.EvidenceAssembled);
		const steered = await store.transition(task.id, TaskTrigger.Steer);
		assert.strictEqual(steered.outcome, TransitionOutcome.Applied);
		assert.strictEqual(steered.task!.state, LogicalTaskState.Cooking);
		assert.strictEqual(steered.task!.attempts.length, 2);
		assert.strictEqual(steered.task!.currentAttempt, 1);
		assert.strictEqual(steered.task!.evidence!.historical, true);
	});

	test('stale CAS fence rejects acting on a superseded evidence revision (I6)', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		await store.setEvidence(task.id, {
			decisionSentence: 'ready', claims: [], gapLine: 'x', freshness: { computedAt: 1 },
		});
		await store.transition(task.id, TaskTrigger.EvidenceAssembled);
		// Caller believes it is acting on revision 0, but a newer revision landed.
		await store.setEvidence(task.id, {
			decisionSentence: 'ready v2', claims: [], gapLine: 'x', freshness: { computedAt: 2 },
		});
		const res = await store.transition(task.id, TaskTrigger.Accept, undefined, { expected: { evidenceRevision: 0 } });
		assert.strictEqual(res.outcome, TransitionOutcome.Stale);
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Decision);
	});

	test('setEvidence increments the revision monotonically', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		const r0 = await store.setEvidence(task.id, { decisionSentence: 'a', claims: [], gapLine: 'x', freshness: { computedAt: 1 } });
		const r1 = await store.setEvidence(task.id, { decisionSentence: 'b', claims: [], gapLine: 'x', freshness: { computedAt: 2 } });
		assert.strictEqual(r0!.evidence!.revision, 0);
		assert.strictEqual(r1!.evidence!.revision, 1);
	});

	test('markDeliverySeen dedupes delivery ids (I2)', async () => {
		const store = createStore();
		assert.strictEqual(await store.markDeliverySeen('gh-1'), true);
		assert.strictEqual(await store.markDeliverySeen('gh-1'), false);
		assert.strictEqual(await store.markDeliverySeen('gh-2'), true);
	});

	test('cursors persist per repo', async () => {
		const store = createStore();
		assert.strictEqual(store.getCursor('acme/api'), undefined);
		await store.setCursor('acme/api', '100');
		assert.strictEqual(store.getCursor('acme/api'), '100');
	});

	test('getTaskBySession resolves the owning task (session event routing)', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		await store.updateTask(task.id, { sessionRef: 'session://worker/1' });
		assert.strictEqual(store.getTaskBySession('session://worker/1')!.id, task.id);
	});

	test('recordGesture and getGestures round-trip', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		await store.recordGesture({ taskId: task.id, kind: GestureKind.Dismiss, timestamp: 5 });
		const gestures = store.getGestures(task.id);
		assert.strictEqual(gestures.length, 1);
		assert.strictEqual(gestures[0].kind, GestureKind.Dismiss);
	});

	test('a burst of concurrent mutations all apply without exhausting the CAS budget', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		// Far more concurrent writers than the CAS retry budget: without in-process
		// serialization the losers would exceed the budget (or lose updates); with it
		// every write lands exactly once.
		const N = 40;
		await Promise.all(Array.from({ length: N }, (_, i) =>
			store.recordGesture({ taskId: task.id, kind: GestureKind.Steer, note: `n${i}`, timestamp: i })));
		assert.strictEqual(store.getGestures(task.id).length, N);
	});

	test('Delete permanently removes the archived task', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		await store.transition(task.id, TaskTrigger.CancelWork); // -> archived
		const res = await store.transition(task.id, TaskTrigger.Delete);
		assert.strictEqual(res.outcome, TransitionOutcome.Applied);
		assert.strictEqual(store.getTask(task.id), undefined);
		assert.strictEqual(store.tasks.get().length, 0);
	});

	test('state survives a fresh store instance (durable ledger)', async () => {
		const storage = new InMemoryCasStorage();
		const first = disposables.add(new InboxOneStore(storage));
		const { task } = await first.upsertByGroupKey(init());
		await first.transition(task.id, TaskTrigger.EvidenceAssembled);

		const second = disposables.add(new InboxOneStore(storage));
		// Force hydration through a read path.
		await second.markDeliverySeen('warmup');
		assert.strictEqual(second.getTask(task.id)!.state, LogicalTaskState.Decision);
	});

	test('openContinuation opens exactly one attempt and fences double-sends (G3)', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		await store.transition(task.id, TaskTrigger.EvidenceAssembled); // -> Decision

		const first = await store.openContinuation(task.id, TaskTrigger.Steer, 'cont-key-1');
		assert.strictEqual(first.outcome, TransitionOutcome.Applied);
		assert.strictEqual(first.fencedNoop ?? false, false);
		assert.strictEqual(first.task!.state, LogicalTaskState.Cooking);
		assert.strictEqual(first.task!.attempts.length, 2);

		// A double-send with the same continuation key is a no-op (no third attempt).
		const second = await store.openContinuation(task.id, TaskTrigger.Steer, 'cont-key-1');
		assert.strictEqual(second.fencedNoop, true);
		assert.strictEqual(store.getTask(task.id)!.attempts.length, 2);
	});

	test('openContinuation with a new key opens a fresh cycle', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init());
		await store.transition(task.id, TaskTrigger.EvidenceAssembled);
		await store.openContinuation(task.id, TaskTrigger.Steer, 'k1');
		// Back to a decision, then reopen with a different key.
		await store.transition(task.id, TaskTrigger.EvidenceAssembled);
		const reopened = await store.openContinuation(task.id, TaskTrigger.Steer, 'k2');
		assert.strictEqual(reopened.fencedNoop ?? false, false);
		assert.strictEqual(store.getTask(task.id)!.attempts.length, 3);
	});

	test('openContinuation rejects an illegal transition', async () => {
		const store = createStore();
		const { task } = await store.upsertByGroupKey(init()); // Cooking
		// Steer is illegal from Cooking.
		const res = await store.openContinuation(task.id, TaskTrigger.Steer, 'k1');
		assert.strictEqual(res.outcome, TransitionOutcome.IllegalTransition);
	});
});
