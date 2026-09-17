/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ActionType } from './inboxOneTypes.js';

/**
 * Typed action catalog (design 7.3, technical spec 7). All repository writes go
 * through a fixed catalog of typed, idempotent actions. The model proposes an
 * `action_type` + `payload`; the host validates the payload against the schema
 * here before the executor runs it. An out-of-catalog or malformed action is
 * rejected and never executed.
 *
 * The button LABEL is worker-authored and display-only; the executed action and
 * its host-generated confirmation SENTENCE come entirely from this catalog, so
 * the last gate before a real merge/deploy contains no model free-text (7.1).
 */

// --- typed payloads, one per catalog action ---

export interface IMergePrPayload {
	readonly repo: string;
	readonly prNumber: number;
	readonly base: string;
	readonly strategy: 'merge' | 'squash' | 'rebase';
	readonly rerunChecks?: boolean;
}

export interface IApprovePrPayload {
	readonly repo: string;
	readonly prNumber: number;
	readonly body?: string;
}

/**
 * Open a pull request from a work branch the worker already pushed, optionally
 * enabling auto-merge so it lands automatically once required checks pass. This
 * is the "implement a fix -> open PR -> (auto-)merge" happy path for an issue or
 * a CI fix.
 */
export interface ICreatePrPayload {
	readonly repo: string;
	/** The branch the change is on (already pushed by the worker). */
	readonly head: string;
	/** The branch to merge into (e.g. the default branch). */
	readonly base: string;
	readonly title: string;
	readonly body?: string;
	/** When true, enable auto-merge so the PR lands once required checks pass. */
	readonly autoMerge?: boolean;
	/** Merge strategy for the (auto-)merge; defaults to squash. */
	readonly strategy?: 'merge' | 'squash' | 'rebase';
}

export interface ICommentPayload {
	readonly repo: string;
	/** PR or issue number the comment targets. */
	readonly targetNumber: number;
	readonly body: string;
}

export interface IAddLabelsPayload {
	readonly repo: string;
	readonly targetNumber: number;
	readonly add: readonly string[];
	readonly remove?: readonly string[];
}

export interface ICreateIssuesPayload {
	readonly repo: string;
	readonly issues: readonly { readonly title: string; readonly body?: string; readonly sourceIssues?: readonly number[] }[];
}

export interface IDispatchFixPayload {
	readonly repo: string;
	/** A human-legible subject, e.g. "flaky test on main" or "issue #911". */
	readonly subject: string;
	/** The group_key of the task the child fix attaches to, if any. */
	readonly parentGroupKey?: string;
}

export interface IDeployPayload {
	readonly repo: string;
	readonly env: string;
	/** The sha or artifact id to ship. */
	readonly ref: string;
}

export interface IGrantScopePayload {
	readonly repo: string;
	readonly scope: string;
}

export interface IActionPayloads {
	readonly [ActionType.MergePr]: IMergePrPayload;
	readonly [ActionType.ApprovePr]: IApprovePrPayload;
	readonly [ActionType.CreatePr]: ICreatePrPayload;
	readonly [ActionType.Comment]: ICommentPayload;
	readonly [ActionType.AddLabels]: IAddLabelsPayload;
	readonly [ActionType.CreateIssues]: ICreateIssuesPayload;
	readonly [ActionType.DispatchFix]: IDispatchFixPayload;
	readonly [ActionType.Deploy]: IDeployPayload;
	readonly [ActionType.GrantScope]: IGrantScopePayload;
}

/** Reversibility, stated honestly in the confirmation (design 7.3, tech-spec 7.2). */
export const enum Reversibility {
	Reversible = 'reversible',
	Irreversible = 'irreversible',
}

export interface IActionCatalogEntry {
	readonly actionType: ActionType;
	readonly reversibility: Reversibility;
	/** Whether the action performs an immediate repository write (vs opening child work). */
	readonly writesRepo: boolean;
	/** Whether it is eligible for auto-handle within a conservative autonomy level. */
	readonly autoHandleEligible: boolean;
	/** Validates a proposed payload; returns a list of problems (empty = valid). */
	validate(payload: unknown): string[];
}

// --- validators (pure, defensive) ---

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}
function reqString(o: Record<string, unknown>, k: string, errs: string[]): void {
	if (typeof o[k] !== 'string' || (o[k] as string).length === 0) { errs.push(`${k} must be a non-empty string`); }
}
function reqNumber(o: Record<string, unknown>, k: string, errs: string[]): void {
	if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) { errs.push(`${k} must be a finite number`); }
}
function reqEnum(o: Record<string, unknown>, k: string, allowed: readonly string[], errs: string[]): void {
	if (typeof o[k] !== 'string' || !allowed.includes(o[k] as string)) { errs.push(`${k} must be one of ${allowed.join(', ')}`); }
}
function reqStringArray(o: Record<string, unknown>, k: string, errs: string[], minLen = 1): void {
	const v = o[k];
	if (!Array.isArray(v) || v.length < minLen || v.some(x => typeof x !== 'string' || x.length === 0)) {
		errs.push(`${k} must be an array of >= ${minLen} non-empty strings`);
	}
}
function optEnum(o: Record<string, unknown>, k: string, allowed: readonly string[], errs: string[]): void {
	if (o[k] !== undefined && (typeof o[k] !== 'string' || !allowed.includes(o[k] as string))) { errs.push(`${k}, when set, must be one of ${allowed.join(', ')}`); }
}
function optBool(o: Record<string, unknown>, k: string, errs: string[]): void {
	if (o[k] !== undefined && typeof o[k] !== 'boolean') { errs.push(`${k}, when set, must be a boolean`); }
}

export const ACTION_CATALOG: { readonly [K in ActionType]: IActionCatalogEntry } = {
	[ActionType.MergePr]: {
		actionType: ActionType.MergePr, reversibility: Reversibility.Reversible, writesRepo: true, autoHandleEligible: false,
		validate(p) { const e: string[] = []; if (!isObj(p)) { return ['payload must be an object']; } reqString(p, 'repo', e); reqNumber(p, 'prNumber', e); reqString(p, 'base', e); reqEnum(p, 'strategy', ['merge', 'squash', 'rebase'], e); return e; },
	},
	[ActionType.ApprovePr]: {
		actionType: ActionType.ApprovePr, reversibility: Reversibility.Reversible, writesRepo: true, autoHandleEligible: false,
		validate(p) { const e: string[] = []; if (!isObj(p)) { return ['payload must be an object']; } reqString(p, 'repo', e); reqNumber(p, 'prNumber', e); return e; },
	},
	[ActionType.CreatePr]: {
		actionType: ActionType.CreatePr, reversibility: Reversibility.Reversible, writesRepo: true, autoHandleEligible: false,
		validate(p) { const e: string[] = []; if (!isObj(p)) { return ['payload must be an object']; } reqString(p, 'repo', e); reqString(p, 'head', e); reqString(p, 'base', e); reqString(p, 'title', e); optBool(p, 'autoMerge', e); optEnum(p, 'strategy', ['merge', 'squash', 'rebase'], e); return e; },
	},
	[ActionType.Comment]: {
		actionType: ActionType.Comment, reversibility: Reversibility.Reversible, writesRepo: true, autoHandleEligible: true,
		validate(p) { const e: string[] = []; if (!isObj(p)) { return ['payload must be an object']; } reqString(p, 'repo', e); reqNumber(p, 'targetNumber', e); reqString(p, 'body', e); return e; },
	},
	[ActionType.AddLabels]: {
		actionType: ActionType.AddLabels, reversibility: Reversibility.Reversible, writesRepo: true, autoHandleEligible: true,
		validate(p) { const e: string[] = []; if (!isObj(p)) { return ['payload must be an object']; } reqString(p, 'repo', e); reqNumber(p, 'targetNumber', e); reqStringArray(p, 'add', e); return e; },
	},
	[ActionType.CreateIssues]: {
		actionType: ActionType.CreateIssues, reversibility: Reversibility.Reversible, writesRepo: true, autoHandleEligible: false,
		validate(p) {
			const e: string[] = [];
			if (!isObj(p)) { return ['payload must be an object']; }
			reqString(p, 'repo', e);
			const issues = p.issues;
			if (!Array.isArray(issues) || issues.length === 0) { e.push('issues must be a non-empty array'); }
			else { issues.forEach((it, i) => { if (!isObj(it) || typeof it.title !== 'string' || (it.title as string).length === 0) { e.push(`issues[${i}].title must be a non-empty string`); } }); }
			return e;
		},
	},
	[ActionType.DispatchFix]: {
		actionType: ActionType.DispatchFix, reversibility: Reversibility.Reversible, writesRepo: false, autoHandleEligible: false,
		validate(p) { const e: string[] = []; if (!isObj(p)) { return ['payload must be an object']; } reqString(p, 'repo', e); reqString(p, 'subject', e); return e; },
	},
	[ActionType.Deploy]: {
		actionType: ActionType.Deploy, reversibility: Reversibility.Irreversible, writesRepo: true, autoHandleEligible: false,
		validate(p) { const e: string[] = []; if (!isObj(p)) { return ['payload must be an object']; } reqString(p, 'repo', e); reqString(p, 'env', e); reqString(p, 'ref', e); return e; },
	},
	[ActionType.GrantScope]: {
		actionType: ActionType.GrantScope, reversibility: Reversibility.Reversible, writesRepo: false, autoHandleEligible: false,
		validate(p) { const e: string[] = []; if (!isObj(p)) { return ['payload must be an object']; } reqString(p, 'repo', e); reqString(p, 'scope', e); return e; },
	},
};

export interface IValidationResult {
	readonly valid: boolean;
	readonly problems: readonly string[];
}

/** True when `value` is a known catalog action type. */
export function isKnownActionType(value: string): value is ActionType {
	return Object.prototype.hasOwnProperty.call(ACTION_CATALOG, value);
}

/**
 * Validates a proposed `(actionType, payload)` against the catalog. Rejects
 * out-of-catalog action types and malformed payloads (tech-spec 7.1). This is
 * the host gate the model output must pass before the executor runs anything.
 */
export function validateAction(actionType: string, payload: unknown): IValidationResult {
	if (!isKnownActionType(actionType)) {
		return { valid: false, problems: [`unknown action_type: ${actionType}`] };
	}
	const problems = ACTION_CATALOG[actionType].validate(payload);
	return { valid: problems.length === 0, problems };
}

export function catalogEntry(actionType: ActionType): IActionCatalogEntry {
	return ACTION_CATALOG[actionType];
}

/**
 * A worker-facing payload spec per action: the exact fields, their types, and any
 * finite value set (e.g. the merge strategy enum). Kept beside the validators so
 * the two stay in step; {@link describeActionCatalog} renders it into the worker
 * brief so a proposed action's payload is well-formed the first time (preempting
 * malformed-payload rejections like a bad add_labels).
 */
const ACTION_PAYLOAD_SPECS: { readonly [K in ActionType]: string } = {
	[ActionType.MergePr]: 'repo: string, prNumber: number, base: string (target branch), strategy: "merge" | "squash" | "rebase", rerunChecks?: boolean',
	[ActionType.ApprovePr]: 'repo: string, prNumber: number, body?: string',
	[ActionType.CreatePr]: 'repo: string, head: string (the work branch you already pushed), base: string (branch to merge into), title: string, body?: string, autoMerge?: boolean (land automatically once checks pass), strategy?: "merge" | "squash" | "rebase"',
	[ActionType.Comment]: 'repo: string, targetNumber: number (the PR or issue number), body: string',
	[ActionType.AddLabels]: 'repo: string, targetNumber: number (the PR or issue number), add: string[] (>= 1 label name), remove?: string[]',
	[ActionType.CreateIssues]: 'repo: string, issues: array (>= 1) of { title: string (required), body?: string, sourceIssues?: number[] }',
	[ActionType.DispatchFix]: 'repo: string, subject: string (human-legible), parentGroupKey?: string',
	[ActionType.Deploy]: 'repo: string, env: string, ref: string (sha or artifact id)',
	[ActionType.GrantScope]: 'repo: string, scope: string',
};

/** Sentinel action_type a worker uses when NO catalog action fits but it has a specific ask for the human (answered via Steer). */
export const OTHER_ACTION = 'other';

/**
 * Renders the fixed action catalog for the worker prompt: every action_type with
 * its exact payload fields (including finite value sets like the merge strategy)
 * and reversibility. The worker must choose one action_type and fill its payload
 * exactly; the host validates against the same catalog.
 */
export function describeActionCatalog(): string {
	const actions = (Object.keys(ACTION_CATALOG) as ActionType[])
		.map(t => `- ${t} [${ACTION_CATALOG[t].reversibility}]: { ${ACTION_PAYLOAD_SPECS[t]} }`);
	actions.push(`- ${OTHER_ACTION}: no catalog action fits, but you have a specific recommendation or question for the human. Put that ask in the \`customAsk\` field (a full sentence or two). The inbox will show your ask and the human answers it via Steer -- no payload/label needed.`);
	return actions.join('\n');
}
