/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAutomationStorageService } from '../../automations/common/automationStorageService.js';
import { AdmissionResult, canAdmit as canAdmitPure, dayKey, EMPTY_ADMISSION_STATE, IAdmissionState, reserve as reservePure } from '../common/admissionControl.js';
import { IAdmissionManager } from '../common/coordinatorEngine.js';
import { hasLiveWorker, IInboxOneStore } from '../common/inboxOneStore.js';
import { IInboxOneSettings } from '../common/inboxOneSettings.js';
import { LogicalTaskState } from '../common/inboxOneTypes.js';

const ADMISSION_KEY = 'inboxOne.admission';

/**
 * Durable {@link IAdmissionManager} (design 7.4). Concurrency is derived from the
 * store's live (Cooking/Confirming) attempts so it needs no separate slot ledger;
 * daily credits and the authoritative slot set are persisted through the shared
 * CAS storage so reservations survive restart and are safe under concurrency
 * (I2). Over-budget dispatches queue; slots release on resolve/cancel/fail.
 */
export class LiveAdmissionManager implements IAdmissionManager {

	constructor(
		private readonly store: IInboxOneStore,
		private readonly settings: IInboxOneSettings,
		private readonly storage: IAutomationStorageService,
		private readonly now: () => number = () => Date.now(),
	) { }

	canAdmit(repo: string | undefined): boolean {
		// Concurrency is derived from live tasks; a synchronous probe is enough for
		// the gate. Credits are checked authoritatively at reserve time.
		const caps = this.settings.getBudgetCaps(repo);
		const global = this.liveAttempts().length;
		if (global >= caps.globalConcurrency) {
			return false;
		}
		if (repo) {
			const perRepo = this.liveAttempts().filter(t => t.repo === repo).length;
			if (perRepo >= caps.repoConcurrency) {
				return false;
			}
		}
		return true;
	}

	async tryReserve(taskId: string, attemptIndex: number, repo: string | undefined): Promise<AdmissionResult> {
		const caps = this.settings.getBudgetCaps(repo);
		// Concurrency is derived from the live store; over-budget queues.
		if (!this.canAdmit(repo)) {
			return this.liveAttempts().filter(t => t.repo === repo).length >= caps.repoConcurrency
				? AdmissionResult.QueuedRepoConcurrency
				: AdmissionResult.QueuedGlobalConcurrency;
		}
		// Daily credits are the only durable counter; reserve one via CAS.
		return this.reserveCredit(taskId, attemptIndex, repo);
	}

	async release(taskId: string, attemptIndex: number, repo: string | undefined): Promise<void> {
		await this.mutate(state => {
			const slots = state.slots.filter(s => !(s.taskId === taskId && s.attemptIndex === attemptIndex));
			return { ...state, slots };
		});
	}

	private async reserveCredit(taskId: string, attemptIndex: number, repo: string | undefined): Promise<AdmissionResult> {
		let result = AdmissionResult.Admitted;
		await this.mutate(state => {
			const caps = this.settings.getBudgetCaps(repo);
			const outcome = reservePure(this.pruneStaleSlots(state, taskId), caps, { taskId, attemptIndex, repo }, this.now());
			result = outcome.result;
			return outcome.state;
		});
		return result;
	}

	/**
	 * Drops durable slots whose task is no longer live. A slot is released on
	 * resolve/cancel/fail, but any path that retires a task without that release
	 * (an external edit, or a crash between landing and release) would otherwise
	 * leave the slot reserved forever and permanently wedge the repo's
	 * concurrency -- a dispatch that can only ever queue. Reconciling the durable
	 * set against the live store keeps it self-healing.
	 *
	 * Liveness is deliberately by task state alone, not {@link hasLiveWorker}: a
	 * task that has reserved a slot but not yet launched its worker is still
	 * mid-dispatch, and dropping its slot would let a burst of dispatches
	 * overshoot the cap before any of their session refs land. `reservingTaskId`
	 * is always kept so reservation stays idempotent even before the task's own
	 * state change is visible here.
	 */
	private pruneStaleSlots(state: IAdmissionState, reservingTaskId: string): IAdmissionState {
		const live = new Set<string>([reservingTaskId]);
		for (const task of this.store.tasks.get()) {
			if (task.state === LogicalTaskState.Cooking || task.state === LogicalTaskState.Confirming) {
				live.add(task.id);
			}
		}
		const slots = state.slots.filter(s => live.has(s.taskId));
		return slots.length === state.slots.length ? state : { ...state, slots };
	}

	private liveAttempts(): { id: string; repo?: string }[] {
		const out: { id: string; repo?: string }[] = [];
		for (const task of this.store.tasks.get()) {
			// Only tasks with a live, dispatched worker occupy a concurrency slot.
			// A queued Cooking task (no worker yet) must not count, or the slot budget
			// deadlocks and queued tasks hang forever (the task being dispatched would
			// even block itself).
			if ((task.state === LogicalTaskState.Cooking || task.state === LogicalTaskState.Confirming) && hasLiveWorker(task)) {
				out.push({ id: task.id, repo: task.repo });
			}
		}
		return out;
	}

	// --- durable credit/slot state via CAS ---

	private async mutate(fn: (state: IAdmissionState) => IAdmissionState): Promise<void> {
		for (let i = 0; i < 12; i++) {
			const expected = await this.storage.read(ADMISSION_KEY);
			const current = expected ? this.parse(expected) : { ...EMPTY_ADMISSION_STATE, creditDate: dayKey(this.now()) };
			const next = fn(current);
			const swap = await this.storage.compareAndSwap(ADMISSION_KEY, expected, JSON.stringify(next));
			if (swap.swapped) {
				return;
			}
		}
		throw new Error('LiveAdmissionManager: exceeded CAS retry budget');
	}

	private parse(raw: string): IAdmissionState {
		try {
			const parsed = JSON.parse(raw) as IAdmissionState;
			return {
				slots: parsed.slots ?? [],
				creditDate: parsed.creditDate ?? dayKey(this.now()),
				creditsUsed: parsed.creditsUsed ?? 0,
			};
		} catch {
			return { ...EMPTY_ADMISSION_STATE, creditDate: dayKey(this.now()) };
		}
	}

	/** Reads the current admission state (probe for the credit-cap gate check). */
	async peek(): Promise<IAdmissionState> {
		const raw = await this.storage.read(ADMISSION_KEY);
		return raw ? this.parse(raw) : { ...EMPTY_ADMISSION_STATE, creditDate: dayKey(this.now()) };
	}

	/** Probe whether a slot is currently admissible under credits (for tests/observability). */
	async probeCredits(taskId: string, attemptIndex: number, repo: string | undefined): Promise<AdmissionResult> {
		const state = await this.peek();
		return canAdmitPure(state, this.settings.getBudgetCaps(repo), { taskId, attemptIndex, repo }, this.now());
	}
}
