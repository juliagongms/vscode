/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IAutomationStorageService } from '../../automations/common/automationStorageService.js';
import { getTransition, TaskTrigger } from '../common/inboxOneStateMachine.js';
import { IInboxOneStore, INewTaskInit, ITaskPatch, ITransitionOptions, ITransitionResult, IUpsertResult, TransitionOutcome } from '../common/inboxOneStore.js';
import { AttemptStatus, GroupKey, IAttempt, IDropLedgerEntry, IEvidencePack, IGesture, ILogicalTask, LogicalTaskState } from '../common/inboxOneTypes.js';

/** Storage key for the single serialized Inbox One ledger blob. */
const INBOX_ONE_LEDGER_KEY = 'inboxOne.ledger';

/** Max delivery ids retained for dedupe (FIFO window). */
const MAX_SEEN_DELIVERIES = 5000;
/** Max drop-ledger entries retained. */
const MAX_DROPS = 2000;
/** CAS retry budget for a single mutation before surfacing contention. */
const MAX_CAS_RETRIES = 12;

interface ILedger {
	readonly schemaVersion: number;
	readonly tasks: ILogicalTask[];
	readonly gestures: IGesture[];
	readonly seenDeliveries: string[];
	readonly cursors: Record<string, string>;
	readonly drops: IDropLedgerEntry[];
	readonly consumedContinuations: string[];
}

const EMPTY_LEDGER: ILedger = { schemaVersion: 1, tasks: [], gestures: [], seenDeliveries: [], cursors: {}, drops: [], consumedContinuations: [] };

function routeFor(inboxId: string, taskId: string): string {
	return `agents://inbox/${inboxId}/items/${taskId}`;
}

/**
 * Durable, CAS-backed implementation of {@link IInboxOneStore}.
 *
 * All state lives in one serialized ledger written through the shared
 * compare-and-swap storage primitive (reused from the automations subsystem).
 * Every mutation is a read -> modify -> compare-and-swap loop, so concurrent
 * writers never clobber each other and all effects are idempotent (I1/I2/I3).
 */
export class InboxOneStore extends Disposable implements IInboxOneStore {

	declare readonly _serviceBrand: undefined;

	private readonly _tasks: ISettableObservable<readonly ILogicalTask[]>;
	private _cache: ILedger = EMPTY_LEDGER;
	private _hydrated = false;
	/**
	 * Serializes mutations in-process so a burst of concurrent writers (startup
	 * backfill dispatch, the coordinator, and the learning autoruns all mutate the
	 * one ledger key) never thrash the CAS loop. With writes applied one at a time,
	 * each reads the just-swapped value and swaps first-try; the retry budget then
	 * only ever absorbs genuine cross-process contention.
	 */
	private readonly writeSequencer = new Sequencer();

	constructor(
		@IAutomationStorageService private readonly storage: IAutomationStorageService,
	) {
		super();
		this._tasks = observableValue<readonly ILogicalTask[]>('inboxOneTasks', []);
		// Hydrate persisted tasks eagerly so consumers (the inbox view, the
		// coordinator) reflect durable state on startup, not only after a mutation.
		this.ensureHydrated().catch(() => { /* best-effort; mutations will retry */ });
	}

	get tasks(): IObservable<readonly ILogicalTask[]> {
		return this._tasks;
	}

	private async ensureHydrated(): Promise<void> {
		if (this._hydrated) {
			return;
		}
		this._cache = await this.readLedger();
		this._hydrated = true;
		this._tasks.set(this._cache.tasks.slice(), undefined);
	}

	private async readLedger(): Promise<ILedger> {
		const raw = await this.storage.read(INBOX_ONE_LEDGER_KEY);
		return raw ? safeParse(raw) : { ...EMPTY_LEDGER };
	}

	/**
	 * Read the authoritative ledger, apply `mutate`, and compare-and-swap it back.
	 * Retries on contention. `mutate` returns the next ledger plus a caller result;
	 * returning `undefined` for the ledger aborts the write and returns the result.
	 */
	private async mutate<T>(mutate: (ledger: ILedger) => { next?: ILedger; result: T }): Promise<T> {
		return this.writeSequencer.queue(() => this.mutateExclusive(mutate));
	}

	private async mutateExclusive<T>(mutate: (ledger: ILedger) => { next?: ILedger; result: T }): Promise<T> {
		await this.ensureHydrated();
		let expected = await this.storage.read(INBOX_ONE_LEDGER_KEY);
		let current = expected ? safeParse(expected) : { ...EMPTY_LEDGER };
		for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
			const { next, result } = mutate(current);
			if (!next) {
				this._cache = current;
				this._tasks.set(current.tasks.slice(), undefined);
				return result;
			}
			const serialized = JSON.stringify(next);
			const swap = await this.storage.compareAndSwap(INBOX_ONE_LEDGER_KEY, expected, serialized);
			if (swap.swapped) {
				this._cache = next;
				this._tasks.set(next.tasks.slice(), undefined);
				return result;
			}
			// Lost the race: adopt the authoritative value and retry.
			expected = swap.currentValue;
			current = swap.currentValue ? safeParse(swap.currentValue) : { ...EMPTY_LEDGER };
		}
		throw new Error('InboxOneStore: exceeded compare-and-swap retry budget');
	}

	getTask(taskId: string): ILogicalTask | undefined {
		return this._cache.tasks.find(t => t.id === taskId);
	}

	getTaskByGroupKey(groupKey: GroupKey): ILogicalTask | undefined {
		return this._cache.tasks.find(t => t.groupKey === groupKey);
	}

	getTaskBySession(sessionRef: string): ILogicalTask | undefined {
		return this._cache.tasks.find(t => t.attempts.some(a => a.sessionRef === sessionRef));
	}

	async upsertByGroupKey(init: INewTaskInit): Promise<IUpsertResult> {
		return this.mutate<IUpsertResult>(ledger => {
			const existing = ledger.tasks.find(t => t.groupKey === init.groupKey);
			if (existing) {
				// Idempotent join (I1): a duplicate/later event reuses the same task.
				return { result: { task: existing, created: false } };
			}
			const now = Date.now();
			const id = generateUuid();
			const attempt: IAttempt = {
				id: generateUuid(),
				index: 0,
				trigger: init.firstAttemptTrigger,
				status: AttemptStatus.Running,
				startedAt: now,
			};
			const task: ILogicalTask = {
				id,
				inboxId: init.inboxId,
				repo: init.repo,
				groupKey: init.groupKey,
				sourceEvent: init.sourceEvent,
				type: init.type,
				state: LogicalTaskState.Cooking,
				attempts: [attempt],
				currentAttempt: 0,
				parentTaskId: init.parentTaskId,
				route: routeFor(init.inboxId, id),
				createdAt: now,
				updatedAt: now,
			};
			const next: ILedger = { ...ledger, tasks: [...ledger.tasks, task] };
			return { next, result: { task, created: true } };
		});
	}

	async transition(taskId: string, trigger: TaskTrigger, patch?: ITaskPatch, options?: ITransitionOptions): Promise<ITransitionResult> {
		return this.mutate<ITransitionResult>(ledger => {
			const idx = ledger.tasks.findIndex(t => t.id === taskId);
			if (idx === -1) {
				return { result: { outcome: TransitionOutcome.NotFound } };
			}
			const task = ledger.tasks[idx];
			const transition = getTransition(task.state, trigger);
			if (!transition) {
				return { result: { outcome: TransitionOutcome.IllegalTransition, task } };
			}
			// CAS fence: reject acting on stale evidence / a superseded attempt (I6).
			const expected = options?.expected;
			if (expected) {
				const currentAttemptIndex = task.attempts[task.currentAttempt]?.index ?? 0;
				const currentEvidenceRevision = task.evidence?.revision ?? -1;
				if ((expected.attemptIndex !== undefined && expected.attemptIndex !== currentAttemptIndex) ||
					(expected.evidenceRevision !== undefined && expected.evidenceRevision !== currentEvidenceRevision)) {
					return { result: { outcome: TransitionOutcome.Stale, task } };
				}
			}
			const updated = this.applyTransition(task, transition.to, transition.opensNewAttempt, trigger, patch, options);
			const tasks = transition.terminal
				? ledger.tasks.filter((_, i) => i !== idx)
				: ledger.tasks.map((t, i) => (i === idx ? updated : t));
			const next: ILedger = { ...ledger, tasks };
			return { next, result: { outcome: TransitionOutcome.Applied, task: updated } };
		});
	}

	async openContinuation(taskId: string, trigger: TaskTrigger, continuationKey: string, patch?: ITaskPatch, options?: ITransitionOptions): Promise<ITransitionResult> {
		return this.mutate<ITransitionResult>(ledger => {
			// Fence: a key already consumed means the continuation was already opened
			// (double-send / reopen-vs-auto-reopen race). No-op (G3).
			if (ledger.consumedContinuations.includes(continuationKey)) {
				const task = ledger.tasks.find(t => t.id === taskId);
				return { result: { outcome: TransitionOutcome.Applied, task, fencedNoop: true } };
			}
			const idx = ledger.tasks.findIndex(t => t.id === taskId);
			if (idx === -1) {
				return { result: { outcome: TransitionOutcome.NotFound } };
			}
			const task = ledger.tasks[idx];
			const transition = getTransition(task.state, trigger);
			if (!transition) {
				return { result: { outcome: TransitionOutcome.IllegalTransition, task } };
			}
			const updated = this.applyTransition(task, transition.to, transition.opensNewAttempt, trigger, patch, options);
			const consumed = [...ledger.consumedContinuations, continuationKey];
			const next: ILedger = {
				...ledger,
				tasks: ledger.tasks.map((t, i) => (i === idx ? updated : t)),
				consumedContinuations: consumed,
			};
			return { next, result: { outcome: TransitionOutcome.Applied, task: updated } };
		});
	}

	private applyTransition(task: ILogicalTask, to: LogicalTaskState, opensNewAttempt: boolean, trigger: TaskTrigger, patch?: ITaskPatch, options?: ITransitionOptions): ILogicalTask {
		const now = Date.now();
		let attempts = task.attempts;
		let currentAttempt = task.currentAttempt;
		let evidence = task.evidence;
		if (opensNewAttempt) {
			// Opening a fresh cycle marks prior evidence historical (I6): it can no
			// longer authorize an action.
			evidence = evidence ? { ...evidence, historical: true } : undefined;
			const prevIndex = attempts[attempts.length - 1]?.index ?? -1;
			const newAttempt: IAttempt = {
				id: generateUuid(),
				index: prevIndex + 1,
				trigger: options?.newAttemptTrigger ?? triggerToAttemptTrigger(trigger),
				sessionRef: options?.attemptSessionRef,
				status: AttemptStatus.Running,
				startedAt: now,
			};
			attempts = [...attempts, newAttempt];
			currentAttempt = attempts.length - 1;
		} else if (options?.attemptSessionRef !== undefined) {
			attempts = attempts.map((a, i) => (i === currentAttempt ? { ...a, sessionRef: options.attemptSessionRef } : a));
		}
		return {
			...task,
			state: to,
			tier: patch?.tier ?? task.tier,
			rank: patch?.rank ?? task.rank,
			rankReason: patch?.rankReason ?? task.rankReason,
			type: patch?.type ?? task.type,
			evidence: patch?.evidence ?? evidence,
			recoveryStep: patch?.recoveryStep ?? (to === LogicalTaskState.Blocked ? task.recoveryStep : undefined),
			archiveReason: patch?.archiveReason ?? task.archiveReason,
			attempts,
			currentAttempt,
			updatedAt: now,
		};
	}

	async updateTask(taskId: string, patch: ITaskPatch): Promise<ILogicalTask | undefined> {
		return this.mutate<ILogicalTask | undefined>(ledger => {
			const idx = ledger.tasks.findIndex(t => t.id === taskId);
			if (idx === -1) {
				return { result: undefined };
			}
			const task = ledger.tasks[idx];
			const updated: ILogicalTask = {
				...task,
				tier: patch.tier ?? task.tier,
				rank: patch.rank ?? task.rank,
				rankReason: patch.rankReason ?? task.rankReason,
				type: patch.type ?? task.type,
				evidence: patch.evidence ?? task.evidence,
				recoveryStep: patch.recoveryStep ?? task.recoveryStep,
				archiveReason: patch.archiveReason ?? task.archiveReason,
				attempts: patch.sessionRef !== undefined
					? task.attempts.map((a, i) => (i === task.currentAttempt ? { ...a, sessionRef: patch.sessionRef } : a))
					: task.attempts,
				updatedAt: Date.now(),
			};
			const next: ILedger = { ...ledger, tasks: ledger.tasks.map((t, i) => (i === idx ? updated : t)) };
			return { next, result: updated };
		});
	}

	async setEvidence(taskId: string, evidence: Omit<IEvidencePack, 'revision'>): Promise<ILogicalTask | undefined> {
		return this.mutate<ILogicalTask | undefined>(ledger => {
			const idx = ledger.tasks.findIndex(t => t.id === taskId);
			if (idx === -1) {
				return { result: undefined };
			}
			const task = ledger.tasks[idx];
			const revision = (task.evidence?.revision ?? -1) + 1;
			const pack: IEvidencePack = { ...evidence, revision };
			const updated: ILogicalTask = { ...task, evidence: pack, updatedAt: Date.now() };
			const next: ILedger = { ...ledger, tasks: ledger.tasks.map((t, i) => (i === idx ? updated : t)) };
			return { next, result: updated };
		});
	}

	async recordGesture(gesture: IGesture): Promise<void> {
		await this.mutate<void>(ledger => {
			const next: ILedger = { ...ledger, gestures: [...ledger.gestures, gesture] };
			return { next, result: undefined };
		});
	}

	getGestures(taskId: string): readonly IGesture[] {
		return this._cache.gestures.filter(g => g.taskId === taskId);
	}

	async markDeliverySeen(deliveryId: string): Promise<boolean> {
		return this.mutate<boolean>(ledger => {
			if (ledger.seenDeliveries.includes(deliveryId)) {
				return { result: false };
			}
			const seen = [...ledger.seenDeliveries, deliveryId];
			if (seen.length > MAX_SEEN_DELIVERIES) {
				seen.splice(0, seen.length - MAX_SEEN_DELIVERIES);
			}
			const next: ILedger = { ...ledger, seenDeliveries: seen };
			return { next, result: true };
		});
	}

	getCursor(repo: string): string | undefined {
		return this._cache.cursors[repo];
	}

	async setCursor(repo: string, cursor: string): Promise<void> {
		await this.mutate<void>(ledger => {
			const next: ILedger = { ...ledger, cursors: { ...ledger.cursors, [repo]: cursor } };
			return { next, result: undefined };
		});
	}

	async recordDrop(entry: IDropLedgerEntry): Promise<void> {
		await this.mutate<void>(ledger => {
			const drops = [...ledger.drops, entry];
			if (drops.length > MAX_DROPS) {
				drops.splice(0, drops.length - MAX_DROPS);
			}
			const next: ILedger = { ...ledger, drops };
			return { next, result: undefined };
		});
	}
}

function triggerToAttemptTrigger(trigger: TaskTrigger): IAttempt['trigger'] {
	switch (trigger) {
		case TaskTrigger.Steer: return 'steer' as IAttempt['trigger'];
		case TaskTrigger.Reopen: return 'reopen' as IAttempt['trigger'];
		case TaskTrigger.Retry: return 'retry' as IAttempt['trigger'];
		default: return 'hook' as IAttempt['trigger'];
	}
}

function safeParse(raw: string): ILedger {
	try {
		const parsed = JSON.parse(raw) as ILedger;
		return {
			schemaVersion: parsed.schemaVersion ?? 1,
			tasks: parsed.tasks ?? [],
			gestures: parsed.gestures ?? [],
			seenDeliveries: parsed.seenDeliveries ?? [],
			cursors: parsed.cursors ?? {},
			drops: parsed.drops ?? [],
			consumedContinuations: parsed.consumedContinuations ?? [],
		};
	} catch {
		return { ...EMPTY_LEDGER };
	}
}
