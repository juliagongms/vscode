/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AdmissionResult, dayKey, IBudgetCaps } from '../../common/admissionControl.js';
import { IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../../../automations/common/automationStorageService.js';
import { InboxOneStore } from '../../browser/inboxOneStore.js';
import { LiveAdmissionManager } from '../../browser/liveAdmissionManager.js';
import { AutonomyLevel, IInboxOneSettings, INotificationPreferences, IRepoEnrollment } from '../../common/inboxOneSettings.js';
import { AttemptTrigger, IIngressEvent, EventSource } from '../../common/inboxOneTypes.js';
import { TaskTrigger } from '../../common/inboxOneStateMachine.js';

class InMemoryCasStorage implements IAutomationStorageService {
	declare readonly _serviceBrand: undefined;
	private readonly map = new Map<string, string>();
	async read(key: string): Promise<string | undefined> { return this.map.get(key); }
	async compareAndSwap(key: string, expected: string | undefined, next: string): Promise<IAutomationStorageCompareAndSwapResult> {
		const current = this.map.get(key);
		if (current === expected) { this.map.set(key, next); return { swapped: true, currentValue: next }; }
		return { swapped: false, currentValue: current };
	}
}

class FakeSettings implements IInboxOneSettings {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = new Emitter<void>().event;
	constructor(private readonly caps: IBudgetCaps) { }
	async initialize(): Promise<void> { }
	listEnrollments(): readonly IRepoEnrollment[] { return []; }
	getEnrollment(): IRepoEnrollment | undefined { return undefined; }
	async enrollRepo(): Promise<void> { }
	async updateEnrollment(): Promise<void> { }
	async removeEnrollment(): Promise<void> { }
	isRepoEnrolled(): boolean { return true; }
	isTriggerEnabled(): boolean { return true; }
	getBudgetCaps(): IBudgetCaps { return this.caps; }
	getAutonomy(): AutonomyLevel { return AutonomyLevel.SafeReversible; }
	getNotificationPreferences(): INotificationPreferences { return { pushCritical: true, pushUrgent: true, pushFyi: false }; }
	async setNotificationPreferences(): Promise<void> { }
	getDefaultAutonomy(): AutonomyLevel { return AutonomyLevel.SafeReversible; }
	async setDefaultAutonomy(): Promise<void> { }
	getDefaultBudgets(): IBudgetCaps { return this.caps; }
	async setDefaultBudgets(): Promise<void> { }
}

function ev(repo: string, prNumber: string, deliveryId: string): IIngressEvent {
	return { deliveryId, source: EventSource.World, repo, type: 'pull_request', action: 'opened', subject: { kind: 'pr', id: prNumber }, receivedAt: 0 };
}

suite('Inbox One - LiveAdmissionManager', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const CAPS: IBudgetCaps = { repoConcurrency: 2, globalConcurrency: 3, dailyCredits: 4, workersPerTask: 3 };
	const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

	async function setup(caps = CAPS, now = () => NOW) {
		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const settings = new FakeSettings(caps);
		const mgr = new LiveAdmissionManager(store, settings, new InMemoryCasStorage(), now);
		return { store, settings, mgr };
	}

	/** Create N live (Cooking, dispatched-worker) tasks in a repo. */
	async function seedLiveTasks(store: InboxOneStore, repo: string, count: number, offset = 0): Promise<string[]> {
		const ids: string[] = [];
		for (let n = offset; n < offset + count; n++) {
			const { task } = await store.upsertByGroupKey({ inboxId: 'my', repo, groupKey: `${repo}:pr:${n}`, sourceEvent: ev(repo, String(n), `d${repo}${n}`), type: 'code-review', firstAttemptTrigger: AttemptTrigger.Hook });
			// A live task holds a concurrency slot only once it has a dispatched worker.
			await store.updateTask(task.id, { sessionRef: `agent-host://worker/${task.id}` });
			ids.push(task.id);
		}
		return ids;
	}

	test('admits under concurrency and consumes a credit', async () => {
		const { store, mgr } = await setup();
		const [id] = await seedLiveTasks(store, 'acme/api', 1);
		const r = await mgr.tryReserve(id, 0, 'acme/api');
		assert.strictEqual(r, AdmissionResult.Admitted);
		const state = await mgr.peek();
		assert.strictEqual(state.creditsUsed, 1);
	});

	test('per-repo concurrency derived from live tasks queues', async () => {
		const { store, mgr } = await setup();
		// 2 live tasks in the repo already hit repoConcurrency = 2.
		const ids = await seedLiveTasks(store, 'acme/api', 2);
		assert.strictEqual(mgr.canAdmit('acme/api'), false);
		const r = await mgr.tryReserve(ids[0], 0, 'acme/api');
		assert.strictEqual(r, AdmissionResult.QueuedRepoConcurrency);
	});

	test('global concurrency derived from live tasks queues across repos', async () => {
		const { store, mgr } = await setup();
		await seedLiveTasks(store, 'r1', 2);
		await seedLiveTasks(store, 'r2', 1); // total 3 = globalConcurrency
		assert.strictEqual(mgr.canAdmit('r2'), false);
	});

	test('resolved tasks free concurrency (derived, no manual release needed)', async () => {
		const { store, mgr } = await setup();
		const ids = await seedLiveTasks(store, 'acme/api', 2);
		assert.strictEqual(mgr.canAdmit('acme/api'), false);
		// Resolve one task out of Cooking.
		await store.transition(ids[0], TaskTrigger.EvidenceAssembled); // -> Decision
		assert.strictEqual(mgr.canAdmit('acme/api'), true);
	});

	test('daily credit cap queues once exhausted', async () => {
		const { store, mgr } = await setup({ ...CAPS, repoConcurrency: 10, globalConcurrency: 10, dailyCredits: 2 });
		const ids = await seedLiveTasks(store, 'acme/api', 3);
		assert.strictEqual(await mgr.tryReserve(ids[0], 0, 'acme/api'), AdmissionResult.Admitted);
		assert.strictEqual(await mgr.tryReserve(ids[1], 0, 'acme/api'), AdmissionResult.Admitted);
		assert.strictEqual(await mgr.tryReserve(ids[2], 0, 'acme/api'), AdmissionResult.QueuedDailyCredits);
	});

	test('reserve is idempotent for the same slot', async () => {
		const { store, mgr } = await setup();
		const [id] = await seedLiveTasks(store, 'acme/api', 1);
		await mgr.tryReserve(id, 0, 'acme/api');
		await mgr.tryReserve(id, 0, 'acme/api');
		const state = await mgr.peek();
		assert.strictEqual(state.creditsUsed, 1); // not double-counted
	});

	test('slots left behind by retired tasks do not wedge the repo forever', async () => {
		// Durable state carried over from an earlier run: two slots for this repo
		// whose tasks are gone. A slot is released on resolve/cancel/fail, but any
		// path that retires a task without that release (an external edit, or a
		// crash between landing and release) leaves the slot reserved forever.
		// Two such leaks reach repoConcurrency = 2 and would queue this repo for
		// good -- the dispatch can then only ever queue.
		const storage = new InMemoryCasStorage();
		const leaked = ['gone-1', 'gone-2'].map(taskId => ({ taskId, attemptIndex: 0, repo: 'acme/api' }));
		await storage.compareAndSwap('inboxOne.admission', undefined, JSON.stringify({ slots: leaked, creditDate: dayKey(NOW), creditsUsed: 2 }));

		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const mgr = new LiveAdmissionManager(store, new FakeSettings(CAPS), storage, () => NOW);

		// Nothing is actually running, so a new task must still be admitted: the
		// leaked slots are reconciled against the live store, not counted.
		const [fresh] = await seedLiveTasks(store, 'acme/api', 1);
		assert.strictEqual(await mgr.tryReserve(fresh, 0, 'acme/api'), AdmissionResult.Admitted);
		assert.deepStrictEqual((await mgr.peek()).slots.map(s => s.taskId), [fresh]);
	});

	test('a dispatch burst cannot overshoot the cap before session refs land', async () => {
		const { store, mgr } = await setup();
		// Tasks are admitted one after another in the same tick, before any of them
		// has launched a worker (no session ref yet). The durable slots must still
		// hold the line at repoConcurrency = 2.
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const { task } = await store.upsertByGroupKey({ inboxId: 'my', repo: 'acme/api', groupKey: `acme/api:pr:${i}`, sourceEvent: ev('acme/api', String(i), `d${i}`), type: 'code-review', firstAttemptTrigger: AttemptTrigger.Hook });
			ids.push(task.id);
		}
		assert.strictEqual(await mgr.tryReserve(ids[0], 0, 'acme/api'), AdmissionResult.Admitted);
		assert.strictEqual(await mgr.tryReserve(ids[1], 0, 'acme/api'), AdmissionResult.Admitted);
		assert.strictEqual(await mgr.tryReserve(ids[2], 0, 'acme/api'), AdmissionResult.QueuedRepoConcurrency);
	});

	test('credits reset on a new calendar day', async () => {
		let clock = NOW;
		const { store, mgr } = await setup({ ...CAPS, repoConcurrency: 10, globalConcurrency: 10, dailyCredits: 1 }, () => clock);
		const ids = await seedLiveTasks(store, 'acme/api', 2);
		assert.strictEqual(await mgr.tryReserve(ids[0], 0, 'acme/api'), AdmissionResult.Admitted);
		assert.strictEqual(await mgr.tryReserve(ids[1], 0, 'acme/api'), AdmissionResult.QueuedDailyCredits);
		clock = NOW + 24 * 60 * 60 * 1000;
		assert.strictEqual(await mgr.tryReserve(ids[1], 0, 'acme/api'), AdmissionResult.Admitted);
	});
});
