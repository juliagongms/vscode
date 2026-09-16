/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AdmissionResult, DEFAULT_BUDGET_CAPS, IBudgetCaps } from '../../common/admissionControl.js';
import { CoordinatorEngine, IAdmissionManager } from '../../common/coordinatorEngine.js';
import { IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../../../automations/common/automationStorageService.js';
import { TriggerFamily } from '../../common/eventTaxonomy.js';
import { InboxOneStore } from '../../browser/inboxOneStore.js';
import { AutonomyLevel, IInboxOneSettings, INotificationPreferences, IRepoEnrollment } from '../../common/inboxOneSettings.js';
import { EventSource, IEventSubject, IIngressEvent, LogicalTaskState, ActionType, InboxOneTier, AttemptTrigger } from '../../common/inboxOneTypes.js';
import { IWorkerDispatcher, IWorkerDispatchRequest, IWorkerDispatchResult } from '../../common/workerDispatcher.js';
import { IWorkerOutput, IWorkerResultReader } from '../../common/workerResult.js';
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
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private readonly enrollments = new Map<string, IRepoEnrollment>();
	constructor(enrolled: IRepoEnrollment[] = []) { for (const e of enrolled) { this.enrollments.set(e.repo, e); } }
	async initialize(): Promise<void> { }
	listEnrollments(): readonly IRepoEnrollment[] { return [...this.enrollments.values()]; }
	getEnrollment(repo: string): IRepoEnrollment | undefined { return this.enrollments.get(repo); }
	async enrollRepo(e: IRepoEnrollment): Promise<void> { this.enrollments.set(e.repo, e); }
	async updateEnrollment(repo: string, patch: Partial<IRepoEnrollment>): Promise<void> { const cur = this.enrollments.get(repo); if (cur) { this.enrollments.set(repo, { ...cur, ...patch }); } }
	async removeEnrollment(repo: string): Promise<void> { this.enrollments.delete(repo); }
	isRepoEnrolled(repo: string): boolean { return this.enrollments.get(repo)?.active === true; }
	isTriggerEnabled(repo: string, family: TriggerFamily): boolean {
		const e = this.enrollments.get(repo);
		if (!e || !e.active) { return false; }
		return !e.enabledFamilies || e.enabledFamilies.includes(family);
	}
	getBudgetCaps(): IBudgetCaps { return DEFAULT_BUDGET_CAPS; }
	getAutonomy(): AutonomyLevel { return AutonomyLevel.SafeReversible; }
	getNotificationPreferences(): INotificationPreferences { return { pushCritical: true, pushUrgent: true, pushFyi: false }; }
	async setNotificationPreferences(): Promise<void> { }
	getDefaultAutonomy(): AutonomyLevel { return AutonomyLevel.SafeReversible; }
	async setDefaultAutonomy(): Promise<void> { }
	getDefaultBudgets(): IBudgetCaps { return DEFAULT_BUDGET_CAPS; }
	async setDefaultBudgets(): Promise<void> { }
}

class FakeAdmission implements IAdmissionManager {
	admit = true;
	/** tryReserve outcome when the gate admits (e.g. daily-credit availability). */
	reserveOk = true;
	reserved: string[] = [];
	released: string[] = [];
	async tryReserve(taskId: string, attemptIndex: number): Promise<AdmissionResult> {
		if (!this.admit) { return AdmissionResult.QueuedGlobalConcurrency; }
		if (!this.reserveOk) { return AdmissionResult.QueuedDailyCredits; }
		this.reserved.push(`${taskId}:${attemptIndex}`);
		return AdmissionResult.Admitted;
	}
	canAdmit(): boolean { return this.admit; }
	async release(taskId: string, attemptIndex: number): Promise<void> { this.released.push(`${taskId}:${attemptIndex}`); }
}

class FakeDispatcher implements IWorkerDispatcher {
	dispatched: IWorkerDispatchRequest[] = [];
	relays: { sessionRef: string; message: string }[] = [];
	fail = false;
	defer = false;
	async dispatch(request: IWorkerDispatchRequest): Promise<IWorkerDispatchResult> {
		if (this.fail) { throw new Error('dispatch failed'); }
		this.dispatched.push(request);
		if (this.defer) { return { sessionRef: `inboxone-pending://worker/${request.task.id}`, reused: false, deferred: true }; }
		return { sessionRef: `session://worker/${request.task.id}`, reused: false };
	}
	async relay(sessionRef: string, message: string): Promise<boolean> { this.relays.push({ sessionRef, message }); return this.relayResult; }
	relayResult = true;
}

class FakeResultReader implements IWorkerResultReader {
	output: IWorkerOutput | undefined;
	reads: string[] = [];
	async read(_task: unknown, sessionRef: string): Promise<IWorkerOutput | undefined> {
		this.reads.push(sessionRef);
		return this.output;
	}
}

/** A valid raw worker result (as the emit-result contract produces). */
function validOutput(): IWorkerOutput {
	return {
		result: {
			decisionSentence: 'PR #842 is ready to approve',
			claims: [{ text: '47/47 checks pass', receiptLink: 'https://run/1', rung: 1 }],
			gapLine: 'behavior under production load not verified',
			actionType: ActionType.ApprovePr,
			payload: { repo: 'acme/api', prNumber: 842 },
			label: 'Approve PR',
		},
		signals: { blocking: true, blocksPeople: 2, recipientAffinity: 0.8, evidenceConfidence: 0.9, urgency: 0.6 },
	};
}

function prEvent(subject: Partial<IEventSubject> = {}): IIngressEvent {
	return { deliveryId: 'd1', source: EventSource.World, repo: 'acme/api', type: 'pull_request', action: 'opened', subject: { kind: 'pr', id: '842', ...subject }, receivedAt: 0 };
}

suite('Inbox One - coordinator engine', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function build(enrolled = true) {
		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const settings = new FakeSettings(enrolled ? [{ repo: 'acme/api', active: true }] : []);
		const admission = new FakeAdmission();
		const dispatcher = new FakeDispatcher();
		const engine = new CoordinatorEngine('my', store, settings, admission, dispatcher, new NullLogService());
		return { store, settings, admission, dispatcher, engine };
	}

	test('an enrolled PR event creates a Cooking task and dispatches a worker', async () => {
		const { store, dispatcher, engine } = build();
		await engine.handleEvent(prEvent());
		const tasks = store.tasks.get();
		assert.strictEqual(tasks.length, 1);
		assert.strictEqual(tasks[0].state, LogicalTaskState.Cooking);
		assert.strictEqual(tasks[0].groupKey, 'acme/api:pr:842');
		assert.strictEqual(dispatcher.dispatched.length, 1);
		assert.strictEqual(dispatcher.dispatched[0].role, 'code-review');
		assert.ok(tasks[0].attempts[0].sessionRef, 'session ref recorded on the attempt');
	});

	test('an unenrolled repo drops to the ledger and does not dispatch', async () => {
		const { store, dispatcher, engine } = build(false);
		await engine.handleEvent(prEvent());
		assert.strictEqual(store.tasks.get().length, 0);
		assert.strictEqual(dispatcher.dispatched.length, 0);
	});

	test('a duplicate event joins the existing task (no second dispatch, I1)', async () => {
		const { store, dispatcher, engine } = build();
		await engine.handleEvent(prEvent());
		await engine.handleEvent({ ...prEvent(), deliveryId: 'd2' });
		assert.strictEqual(store.tasks.get().length, 1);
		assert.strictEqual(dispatcher.dispatched.length, 1);
	});

	test('over-budget admission queues instead of dispatching', async () => {
		const { store, dispatcher, admission, engine } = build();
		admission.admit = false;
		await engine.handleEvent(prEvent());
		// The task is created (gate passed) but no worker was dispatched.
		assert.strictEqual(dispatcher.dispatched.length, 0);
		assert.ok(store.tasks.get().length <= 1);
	});

	test('a failed dispatch releases the admission slot and fails the attempt', async () => {
		const { store, dispatcher, admission, engine } = build();
		dispatcher.fail = true;
		await engine.handleEvent(prEvent());
		assert.strictEqual(admission.released.length, 1);
		const task = store.tasks.get()[0];
		assert.strictEqual(task.state, LogicalTaskState.Decision); // failed attempt -> Decision + Retry
	});

	test('a deferred dispatch releases the admission slot but keeps the task cooking (no leak)', async () => {
		const { store, dispatcher, admission, engine } = build();
		dispatcher.defer = true;
		await engine.handleEvent(prEvent());
		// The slot is released so a stuck "no host" task never leaks admission...
		assert.strictEqual(admission.released.length, 1);
		const task = store.tasks.get()[0];
		// ...but the task stays Cooking (recorded intent), not failed.
		assert.strictEqual(task.state, LogicalTaskState.Cooking);
		assert.ok(task.attempts[0].sessionRef?.startsWith('inboxone-pending://'), 'pending ref recorded');
	});

	test('a task queued by admission is dispatched once a slot frees (never hangs)', async () => {
		const { store, dispatcher, admission, engine } = build();
		// The gate admits (a slot looks free) so the task is created, but the reserve
		// queues it (e.g. daily credits) so no worker starts -- an admission-queued task.
		admission.reserveOk = false;
		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		assert.strictEqual(task.state, LogicalTaskState.Cooking);
		assert.strictEqual(task.attempts[0].sessionRef, undefined, 'queued: no worker started yet');
		assert.strictEqual(dispatcher.dispatched.length, 0, 'nothing dispatched while queued');

		// Capacity frees; the next event pumps the queue and the task finally dispatches.
		admission.reserveOk = true;
		await engine.handleEvent({ deliveryId: 'noop', source: EventSource.Session, sessionId: 'nobody', type: 'idle', subject: { kind: 'session', id: 'nobody' }, receivedAt: 0 });

		assert.strictEqual(dispatcher.dispatched.length, 1, 'the queued task dispatched when capacity freed');
		assert.ok(store.getTask(task.id)!.attempts[0].sessionRef?.startsWith('session://worker/'), 'now has a live worker');
	});

	test('a needs_input session event blocks the owning task (genuine ask for the human)', async () => {
		const { store, dispatcher, engine } = build();
		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		const sessionId = task.attempts[0].sessionRef!.replace('session://worker/', '');
		await engine.handleEvent({ deliveryId: 'se1', source: EventSource.Session, sessionId, type: 'needs_input', subject: { kind: 'session', id: sessionId }, receivedAt: 0 });
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Blocked);
		assert.strictEqual(dispatcher.relays.length, 0, 'needs_input is a human ask, not a finalize trigger');
	});

	test('a task_finished with no result asks the worker to finalize once, then fails', async () => {
		const { store, dispatcher, engine } = build();
		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		const sessionRef = task.attempts[0].sessionRef!;
		const sessionId = sessionRef.replace('session://worker/', '');
		const finished = { deliveryId: 'tf1', source: EventSource.Session, sessionId, type: 'task_finished' as const, subject: { kind: 'session' as const, id: sessionId }, receivedAt: 0 };

		// First idle turn without a result: ask the worker to finalize (stay Cooking).
		await engine.handleEvent(finished);
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Cooking, 'stays cooking after a finalize request');
		assert.strictEqual(dispatcher.relays.length, 1, 'a single finalize relay was sent');
		assert.ok(dispatcher.relays[0].message.includes('inbox-one-result'), 'the finalize relay asks for the result block');

		// Still nothing after finalize: fail the attempt (surfaced as a Decision).
		await engine.handleEvent({ ...finished, deliveryId: 'tf1b' });
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Decision);
		assert.strictEqual(dispatcher.relays.length, 1, 'finalize is not relayed twice for one attempt');
	});

	test('a needs_input turn that already produced a valid result lands a decision, not a block', async () => {
		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const reader = new FakeResultReader();
		reader.output = validOutput();
		const engine = new CoordinatorEngine('my', store, new FakeSettings([{ repo: 'acme/api', active: true }]), new FakeAdmission(), new FakeDispatcher(), new NullLogService(), undefined, reader);

		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		const sessionId = task.attempts[0].sessionRef!.replace('session://worker/', '');
		// Agent sessions end a turn as needs-input; if the result is already there, land it.
		await engine.handleEvent({ deliveryId: 'ni2', source: EventSource.Session, sessionId, type: 'needs_input', subject: { kind: 'session', id: sessionId }, receivedAt: 0 });

		const landed = store.getTask(task.id)!;
		assert.strictEqual(landed.state, LogicalTaskState.Decision, 'a turn with a valid result lands as a decision');
		assert.strictEqual(landed.evidence!.decisionSentence, 'PR #842 is ready to approve');
	});

	test('a failed session event fails the owning attempt', async () => {
		const { store, engine } = build();
		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		const sessionId = task.attempts[0].sessionRef!.replace('session://worker/', '');
		await engine.handleEvent({ deliveryId: 'se2', source: EventSource.Session, sessionId, type: 'failed', subject: { kind: 'session', id: sessionId }, receivedAt: 0 });
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Decision);
	});

	test('a session event for an unknown session is ignored', async () => {
		const { store, engine } = build();
		await engine.handleEvent({ deliveryId: 'se3', source: EventSource.Session, sessionId: 'ghost', type: 'failed', subject: { kind: 'session', id: 'ghost' }, receivedAt: 0 });
		assert.strictEqual(store.tasks.get().length, 0);
	});

	test('a finished worker lands a host-ranked, evidence-backed decision (no hardcoding)', async () => {
		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const reader = new FakeResultReader();
		reader.output = validOutput();
		const engine = new CoordinatorEngine('my', store, new FakeSettings([{ repo: 'acme/api', active: true }]), new FakeAdmission(), new FakeDispatcher(), new NullLogService(), undefined, reader);

		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		const sessionId = task.attempts[0].sessionRef!.replace('session://worker/', '');
		await engine.handleEvent({ deliveryId: 'sf1', source: EventSource.Session, sessionId, type: 'task_finished', subject: { kind: 'session', id: sessionId }, receivedAt: 0 });

		const landed = store.getTask(task.id)!;
		assert.strictEqual(landed.state, LogicalTaskState.Decision);
		// Evidence came from the worker's emitted result, validated by the host.
		assert.strictEqual(landed.evidence!.decisionSentence, 'PR #842 is ready to approve');
		assert.strictEqual(landed.evidence!.primaryAction!.actionType, ActionType.ApprovePr);
		// Tier + reason were computed by the host ranker from real signals, not authored.
		assert.strictEqual(landed.tier, InboxOneTier.Urgent);
		assert.ok(landed.rankReason && landed.rankReason.length > 0);
		assert.strictEqual(reader.reads.length, 1, 'the worker result was read once');
	});

	test('an invalid worker result, after a finalize retry, lands a coherent needs-direction decision', async () => {
		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const reader = new FakeResultReader();
		reader.output = { result: { decisionSentence: '', claims: [], gapLine: '' }, signals: {} }; // missing mandatory evidence
		const engine = new CoordinatorEngine('my', store, new FakeSettings([{ repo: 'acme/api', active: true }]), new FakeAdmission(), new FakeDispatcher(), new NullLogService(), undefined, reader);

		await engine.handleEvent(prEvent());
		const task = store.tasks.get()[0];
		const sessionId = task.attempts[0].sessionRef!.replace('session://worker/', '');
		const finished = { deliveryId: 'sf2', source: EventSource.Session, sessionId, type: 'task_finished' as const, subject: { kind: 'session' as const, id: sessionId }, receivedAt: 0 };
		// First idle turn: the invalid result triggers one finalize retry (stay Cooking).
		await engine.handleEvent(finished);
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Cooking);
		// Still invalid after the retry: land a coherent, steerable item asking for direction.
		await engine.handleEvent({ ...finished, deliveryId: 'sf2b' });

		const landed = store.getTask(task.id)!;
		// A failed attempt surfaces as a COHERENT Decision the human can steer -- never a
		// fabricated success, and never an empty, un-steerable Decision.
		assert.strictEqual(landed.state, LogicalTaskState.Decision);
		assert.ok(landed.evidence, 'lands a coherent needs-direction item');
		assert.ok(landed.evidence!.customAsk, 'surfaces a customAsk so Steer is the primary affordance');
		assert.strictEqual(landed.evidence!.claims.length, 0, 'no domain claims are fabricated');
	});

	test('a finished conversation thread is NOT turned into a fabricated failed decision', async () => {
		// A conversation thread (a chat Diffy did not dispatch) surfaced by triage
		// as a Blocked inbox item. When it later completes, its lifecycle reaches the
		// coordinator, but there is no emit-result block to parse: the guard must
		// leave it for the human to clear rather than fail-parse it into a Decision.
		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const reader = new FakeResultReader();
		reader.output = validOutput();
		const engine = new CoordinatorEngine('my', store, new FakeSettings([{ repo: 'acme/api', active: true }]), new FakeAdmission(), new FakeDispatcher(), new NullLogService(), undefined, reader);

		const sessionRef = 'agent-session://chat/abc';
		const { task } = await store.upsertByGroupKey({
			inboxId: 'my',
			groupKey: 'session:abc',
			sourceEvent: { deliveryId: 'c1', source: EventSource.Session, sessionId: sessionRef, type: 'needs_input', subject: { kind: 'session', id: 'abc' }, receivedAt: 0 },
			type: 'conversation',
			firstAttemptTrigger: AttemptTrigger.Hook,
		});
		await store.updateTask(task.id, { sessionRef });
		await store.transition(task.id, TaskTrigger.Blocker, { recoveryStep: 'Open the conversation and reply.' });
		assert.strictEqual(store.getTask(task.id)!.state, LogicalTaskState.Blocked);

		await engine.handleEvent({ deliveryId: 'cf1', source: EventSource.Session, sessionId: sessionRef, type: 'task_finished', subject: { kind: 'session', id: 'abc' }, receivedAt: 0 });

		const landed = store.getTask(task.id)!;
		assert.strictEqual(landed.state, LogicalTaskState.Blocked, 'the conversation stays Blocked, not a fabricated Decision');
		assert.strictEqual(reader.reads.length, 0, 'no worker-result parse was attempted for a conversation');
	});

	test('a disabled trigger family drops', async () => {
		const store = disposables.add(new InboxOneStore(new InMemoryCasStorage()));
		const settings = new FakeSettings([{ repo: 'acme/api', active: true, enabledFamilies: [TriggerFamily.Issues] }]);
		const dispatcher = new FakeDispatcher();
		const engine = new CoordinatorEngine('my', store, settings, new FakeAdmission(), dispatcher, new NullLogService());
		await engine.handleEvent(prEvent()); // PR family not enabled
		assert.strictEqual(dispatcher.dispatched.length, 0);
	});
});
