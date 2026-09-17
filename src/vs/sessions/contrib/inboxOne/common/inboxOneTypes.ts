/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Inbox One durable domain model (provider-neutral, serializable).
 *
 * This is the shared vocabulary for the coordinator ("Diffy") loop, the tiered
 * decisions inbox, the typed action executor, and the learning loop. It mirrors
 * the durable objects in the design spec (8) and the technical spec (5 state
 * machine, 3 ingress, 7 executor).
 *
 * Everything here is plain data so it can be persisted through the CAS store and
 * projected to desktop/mobile clients without transport-specific coupling.
 */

/** Stable identity of "the same real problem" - derived deterministically from an event. See {@link deriveGroupKey}. */
export type GroupKey = string;

/** Decision tiers. Tiering (which section) is a policy separate from rank (design 7.1). */
export const enum InboxOneTier {
	Critical = 'critical',
	Urgent = 'urgent',
	Fyi = 'fyi',
}

/**
 * Lifecycle states of a {@link ILogicalTask} (tech-spec 5). `confirming` is a
 * transient state entered after Accept while an async external effect settles.
 */
export const enum LogicalTaskState {
	Cooking = 'cooking',
	Decision = 'decision',
	Blocked = 'blocked',
	Confirming = 'confirming',
	Completed = 'completed',
	Archived = 'archived',
}

/** Whether an ambient event came from world monitoring (GitHub) or an agent session. */
export const enum EventSource {
	World = 'world',
	Session = 'session',
}

/** What caused a new {@link IAttempt} (cycle) to open. */
export const enum AttemptTrigger {
	Hook = 'hook',
	Steer = 'steer',
	Reopen = 'reopen',
	Retry = 'retry',
}

/** Status of a single {@link IAttempt}. */
export const enum AttemptStatus {
	Running = 'running',
	Blocked = 'blocked',
	Failed = 'failed',
	Done = 'done',
}

/**
 * Human gesture on a decision. `dismiss` vs `steer` is the signal disambiguation
 * that must never collapse (design 3.4): dismiss = surfacing was wrong; steer =
 * surfacing was right, the work was wrong.
 */
export const enum GestureKind {
	Accept = 'accept',
	Steer = 'steer',
	Dismiss = 'dismiss',
	Snooze = 'snooze',
	Rerank = 'rerank',
	/** "Not my area" from the Why-this-rank popover (design 3.4): a rank-lowering DRI/authority signal, distinct from dismiss. */
	NotMyArea = 'not_my_area',
}

/**
 * The fixed, host-validated catalog of typed repository writes (tech-spec 7).
 * The model proposes a payload for one of these; the executor validates and runs
 * it with an idempotency key. The model never issues raw writes.
 */
export const enum ActionType {
	MergePr = 'merge_pr',
	ApprovePr = 'approve_pr',
	CreatePr = 'create_pr',
	Comment = 'comment',
	AddLabels = 'add_labels',
	CreateIssues = 'create_issues',
	DispatchFix = 'dispatch_fix',
	Deploy = 'deploy',
	GrantScope = 'grant_scope',
}

/** Status of a typed executor action (tech-spec 7). */
export const enum ExecutorReceiptStatus {
	Confirming = 'confirming',
	Done = 'done',
	Failed = 'failed',
}

/**
 * An internal verifiability rung used only to weight/order claims (design 7.2).
 * Rungs are host-computed from the receipt type and are never shown to the user.
 */
export const enum EvidenceRung {
	Illustrative = 0,
	SingleRun = 1,
	ReproducibleTest = 2,
	Invariant = 4,
	SourceLineage = 5,
	ExecutableModel = 6,
	Formal = 8,
}

/**
 * A normalized ambient event (tech-spec 3). Both GitHub world events and agent
 * session lifecycle events normalize to this one shape and are handled
 * identically (gate -> group_key -> dispatch/land).
 */
export interface IIngressEvent {
	/** GitHub `X-GitHub-Delivery` GUID or the session-event id. The dedupe key. */
	readonly deliveryId: string;
	readonly source: EventSource;
	/** `{owner}/{repo}` when the event pertains to a repository. */
	readonly repo?: string;
	/** Present for agent session events; resolves to the owning task. */
	readonly sessionId?: string;
	/** Webhook-shaped event type, e.g. `pull_request`, `check_run`, `issues`, or a session lifecycle type. */
	readonly type: string;
	/** The event action where present, e.g. `opened`, `labeled`, `completed`. */
	readonly action?: string;
	/** A stable subject descriptor used to derive the {@link GroupKey}. */
	readonly subject: IEventSubject;
	/** Raw provider payload, retained for evidence assembly. Opaque to shared code. */
	readonly payload?: unknown;
	/** Monotonic per-repo cursor position at which this event was observed. */
	readonly cursor?: string;
	readonly receivedAt: number;
}

/** Describes the subject of an event enough to derive its {@link GroupKey} deterministically. */
export interface IEventSubject {
	readonly kind: 'pr' | 'check' | 'issue' | 'issue-cluster' | 'security' | 'deploy' | 'session' | 'branch';
	/** e.g. PR number, issue number, cve/alert id, env, theme slug, session id, branch name. */
	readonly id: string;
	/** For check/CI subjects that attach to a PR or branch task. */
	readonly attachedTo?: { readonly kind: 'pr' | 'branch'; readonly id: string };
}

/** One human-legible claim in an evidence pack, grounded in a real receipt (design 3.3, 7.2). */
export interface IEvidenceClaim {
	readonly text: string;
	/** Deep link to the ground truth (run log / diff / thread). */
	readonly receiptLink?: string;
	/** Host-computed; internal only. */
	readonly rung: EvidenceRung;
}

/** The exact inputs an evidence pack was computed from, for staleness checks (design 7.2). */
export interface IEvidenceFreshness {
	readonly headSha?: string;
	readonly checkIds?: readonly string[];
	readonly eventCursor?: string;
	readonly computedAt: number;
}

/**
 * The primary "Accept" action. The button {@link label} is worker-authored and
 * display-only; the executed {@link actionType} + {@link payload} is the fixed,
 * host-validated catalog item (design 3.4, tech-spec 7.1).
 */
export interface IPrimaryAction {
	/** Worker-authored, free-form, task-specific, <= 3-4 words. Display only. */
	readonly label: string;
	readonly actionType: ActionType;
	/** Typed payload validated by the executor against the action's schema. */
	readonly payload: unknown;
}

/**
 * A revision of the decision-ready result for a task (design 8). Lead with the
 * consequence; 2-3 claims; a mandatory honest gap line.
 */
export interface IEvidencePack {
	readonly revision: number;
	/** A short worker-authored headline (a few words) used as the inbox list title. */
	readonly title?: string;
	readonly decisionSentence: string;
	/** Present when the worker chose the `other` action: a specific ask for the human, answered via Steer (no typed action). */
	readonly customAsk?: string;
	readonly claims: readonly IEvidenceClaim[];
	/** The mandatory one-line "Not verified" gap. */
	readonly gapLine: string;
	readonly freshness: IEvidenceFreshness;
	readonly primaryAction?: IPrimaryAction;
	/** Set true once superseded by a newer revision or a new cycle; can no longer authorize an action. */
	readonly historical?: boolean;
}

/** One execution attempt / cycle of a task (design 8, tech-spec 5). */
export interface IAttempt {
	readonly id: string;
	readonly index: number;
	readonly trigger: AttemptTrigger;
	/** Provider-neutral resource of the worker session backing this attempt. */
	readonly sessionRef?: string;
	readonly status: AttemptStatus;
	readonly startedAt: number;
}

/** One durable problem, persisting across every cycle (design 3.6, 8). */
export interface ILogicalTask {
	readonly id: string;
	readonly inboxId: string;
	readonly repo?: string;
	readonly groupKey: GroupKey;
	/** The event that first created the task. */
	readonly sourceEvent: IIngressEvent;
	/** A short descriptor of the kind of work, e.g. `issue-triage`, `code-review`. */
	readonly type: string;
	readonly state: LogicalTaskState;
	readonly tier?: InboxOneTier;
	/** Host-computed rank within a tier; higher sorts first. */
	readonly rank?: number;
	/** Plain-language reason for the rank/tier (design 7.1). No score chrome. */
	readonly rankReason?: string;
	readonly attempts: readonly IAttempt[];
	/** Index into {@link attempts} of the live cycle. */
	readonly currentAttempt: number;
	readonly parentTaskId?: string;
	/** Latest evidence pack revision, if any. */
	readonly evidence?: IEvidencePack;
	/** Stable deep-link route, e.g. `agents://inbox/{inbox}/items/{id}`. */
	readonly route: string;
	/** For Blocked: the single recovery step to unblock (design 3.6). */
	readonly recoveryStep?: string;
	/** For Archived: why it was archived (dismiss reason / cancel reason). */
	readonly archiveReason?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** A recorded human gesture and its full steering signal (design 8). */
export interface IGesture {
	readonly taskId: string;
	readonly kind: GestureKind;
	/** The user's steering/correction text, when the gesture carried one (design 6.2). */
	readonly note?: string;
	/** Reference to the captured steering transcript in `/experience`. */
	readonly steeringTranscriptRef?: string;
	readonly timestamp: number;
}

/** The receipt of one typed executor action (design 8, tech-spec 7). */
export interface IExecutorReceipt {
	readonly id: string;
	readonly actionType: ActionType;
	readonly payload: unknown;
	readonly idempotencyKey: string;
	/** External reference to confirm against (e.g. a GitHub Actions run id). */
	readonly externalRef?: string;
	readonly status: ExecutorReceiptStatus;
	/** For failures, a human-legible reason surfaced as an evidence claim. */
	readonly failureReason?: string;
}

/** A push/badge notification record (design 8, 7.5). */
export interface INotification {
	readonly taskId: string;
	readonly tier: InboxOneTier;
	readonly groupKey: GroupKey;
	readonly deliveredAt: number;
	readonly route: string;
}

/** A dropped-event ledger entry - the only place a non-dispatched event is recorded (design 4). */
export interface IDropLedgerEntry {
	readonly deliveryId: string;
	readonly groupKey?: GroupKey;
	readonly reason: string;
	readonly droppedAt: number;
}
