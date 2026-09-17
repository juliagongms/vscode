/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LogicalTaskState } from './inboxOneTypes.js';

/**
 * LogicalTask state machine (technical spec 5, design 3.6).
 *
 * A LogicalTask owns an ordered list of Attempts (cycles). This module is the
 * pure, side-effect-free transition table; the durable store applies these
 * transitions inside a single CAS transaction and owns attempt bookkeeping,
 * evidence-revision history, and admission reservations.
 *
 * ```
 * create/reactivate --> cooking(attempt N)
 * cooking     --> decision            (evidence assembled, ranked)
 * cooking     --> blocked             (human-only fact needed)
 * cooking     --> decision(failed)    (attempt errored -> Retry action)
 * cooking     --> confirming          (auto-handled accept within autonomy)
 * cooking     --> archived            (Cancel work)
 * decision    --> cooking(attempt+1)  (Steer / Retry / material change)
 * decision    --> confirming          (Accept)
 * decision    --> archived            (Dismiss)
 * confirming  --> completed           (external effect confirmed)
 * confirming  --> decision(failed)    (external effect failed)
 * blocked     --> cooking(attempt+1)  (recovery supplied / Steer)
 * blocked     --> archived            (Dismiss)
 * completed   --> cooking(attempt+1)  (Reopen / material change)
 * archived    --> decision            (Restore, prior tier)
 * archived    --> (removed)           (Delete permanently)
 * ```
 */
export const enum TaskTrigger {
	/** Worker assembled fresh evidence; host ranked it into a tier. */
	EvidenceAssembled = 'evidence_assembled',
	/** Worker needs a human-only fact/permission. */
	Blocker = 'blocker',
	/** Attempt errored or produced no trustworthy evidence. */
	AttemptFailed = 'attempt_failed',
	/** User cancelled the in-flight work. */
	CancelWork = 'cancel_work',
	/** User steered a decision/blocker - Diffy-mediated new attempt, same task. */
	Steer = 'steer',
	/** User accepted a decision - the typed executor runs the action. */
	Accept = 'accept',
	/** Diffy auto-executed within the autonomy level; lands as FYI "done". */
	AutoAccept = 'auto_accept',
	/** The external effect of an accepted action was confirmed. */
	ConfirmSucceeded = 'confirm_succeeded',
	/** The external effect failed/timed out. */
	ConfirmFailed = 'confirm_failed',
	/** User dismissed a decision/blocker - surfacing was wrong. */
	Dismiss = 'dismiss',
	/** A human-only blocker was resolved. */
	RecoverySupplied = 'recovery_supplied',
	/** The worker itself resumed after a needs-input pause (human answered in the session). Same attempt. */
	WorkerResumed = 'worker_resumed',
	/** User retried a failed-attempt decision. */
	Retry = 'retry',
	/** User reopened a completed task to extend it. */
	Reopen = 'reopen',
	/** A new authoritative event superseded a stamped input on the same group_key. */
	MaterialChange = 'material_change',
	/** User restored an archived task to its prior tier. */
	Restore = 'restore',
	/** User permanently deleted an archived task. */
	Delete = 'delete',
}

export interface ITaskTransition {
	readonly to: LogicalTaskState;
	/** Whether a fresh Attempt (cycle) should be admitted and appended. */
	readonly opensNewAttempt: boolean;
	/** Whether this transition removes the task entirely (Delete). */
	readonly terminal?: boolean;
}

type TransitionMap = { readonly [K in LogicalTaskState]?: { readonly [T in TaskTrigger]?: ITaskTransition } };

const T = (to: LogicalTaskState, opensNewAttempt = false, terminal = false): ITaskTransition => ({ to, opensNewAttempt, terminal });

const TRANSITIONS: TransitionMap = {
	[LogicalTaskState.Cooking]: {
		[TaskTrigger.EvidenceAssembled]: T(LogicalTaskState.Decision),
		[TaskTrigger.Blocker]: T(LogicalTaskState.Blocked),
		[TaskTrigger.AttemptFailed]: T(LogicalTaskState.Decision),
		[TaskTrigger.AutoAccept]: T(LogicalTaskState.Confirming),
		[TaskTrigger.CancelWork]: T(LogicalTaskState.Archived),
	},
	[LogicalTaskState.Decision]: {
		[TaskTrigger.Steer]: T(LogicalTaskState.Cooking, true),
		[TaskTrigger.Retry]: T(LogicalTaskState.Cooking, true),
		[TaskTrigger.MaterialChange]: T(LogicalTaskState.Cooking, true),
		[TaskTrigger.Accept]: T(LogicalTaskState.Confirming),
		[TaskTrigger.Dismiss]: T(LogicalTaskState.Archived),
	},
	[LogicalTaskState.Blocked]: {
		[TaskTrigger.RecoverySupplied]: T(LogicalTaskState.Cooking, true),
		[TaskTrigger.WorkerResumed]: T(LogicalTaskState.Cooking),
		[TaskTrigger.Steer]: T(LogicalTaskState.Cooking, true),
		[TaskTrigger.Dismiss]: T(LogicalTaskState.Archived),
	},
	[LogicalTaskState.Confirming]: {
		[TaskTrigger.ConfirmSucceeded]: T(LogicalTaskState.Completed),
		[TaskTrigger.ConfirmFailed]: T(LogicalTaskState.Decision),
	},
	[LogicalTaskState.Completed]: {
		[TaskTrigger.Reopen]: T(LogicalTaskState.Cooking, true),
		[TaskTrigger.MaterialChange]: T(LogicalTaskState.Cooking, true),
	},
	[LogicalTaskState.Archived]: {
		[TaskTrigger.Restore]: T(LogicalTaskState.Decision),
		[TaskTrigger.Delete]: T(LogicalTaskState.Archived, false, true),
	},
};

/**
 * Returns the transition for a `(state, trigger)` pair, or `undefined` if the
 * transition is illegal. The store must reject illegal transitions.
 */
export function getTransition(from: LogicalTaskState, trigger: TaskTrigger): ITaskTransition | undefined {
	return TRANSITIONS[from]?.[trigger];
}

/** True when `trigger` is legal from `from`. */
export function canTransition(from: LogicalTaskState, trigger: TaskTrigger): boolean {
	return getTransition(from, trigger) !== undefined;
}

/** States from which a task can no longer change (only Completed via reopen, or Archived via restore, re-enter). */
export function isResolvedState(state: LogicalTaskState): boolean {
	return state === LogicalTaskState.Completed || state === LogicalTaskState.Archived;
}

/** The three decision tiers plus Blocked render as decisions the human acts on. */
export function isDecisionState(state: LogicalTaskState): boolean {
	return state === LogicalTaskState.Decision || state === LogicalTaskState.Blocked;
}

/** Whether the task is actively being worked (shown in the Cooking section). */
export function isCookingState(state: LogicalTaskState): boolean {
	return state === LogicalTaskState.Cooking || state === LogicalTaskState.Confirming;
}
