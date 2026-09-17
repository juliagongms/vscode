/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ACTION_CATALOG, IActionPayloads, Reversibility } from './actionCatalog.js';
import { ActionType } from './inboxOneTypes.js';

/**
 * Host-generated confirmation templates (design 7.3, technical spec 7.2).
 *
 * The confirmation SENTENCE is generated deterministically by the host from the
 * typed action + payload -- never model free-text -- so the last gate before a
 * real merge/deploy is trustworthy. The model authors only the short button
 * label; everything the user reads about what will run comes from here.
 */

export interface IActionConfirmation {
	/** One or more host-generated effect lines ("This will: ..."). */
	readonly effectLines: readonly string[];
	/** Honest reversibility line; highlighted when irreversible. */
	readonly reversibilityLine: string;
	readonly reversibility: Reversibility;
	/** Whether the confirmation must be visually emphasized (irreversible effects). */
	readonly highlight: boolean;
}

function reversibilityLine(actionType: ActionType): { line: string; reversibility: Reversibility } {
	const reversibility = ACTION_CATALOG[actionType].reversibility;
	switch (actionType) {
		case ActionType.MergePr: return { line: 'Reversible - one-click revert PR', reversibility };
		case ActionType.ApprovePr: return { line: 'Reversible - dismiss review', reversibility };
		case ActionType.CreatePr: return { line: 'Reversible - close the PR (and revert if it lands)', reversibility };
		case ActionType.Comment: return { line: 'Reversible - editable/deletable', reversibility };
		case ActionType.AddLabels: return { line: 'Reversible - labels removable', reversibility };
		case ActionType.CreateIssues: return { line: 'Reversible - issues closeable', reversibility };
		case ActionType.DispatchFix: return { line: 'Reversible - cancel the Cooking work', reversibility };
		case ActionType.Deploy: return { line: 'IRREVERSIBLE - rollback = redeploy previous', reversibility };
		case ActionType.GrantScope: return { line: 'Reversible - revoke in Settings', reversibility };
	}
}

/**
 * Builds the host-generated confirmation for a validated `(actionType, payload)`.
 * Callers MUST validate the payload first (see `validateAction`); this function
 * assumes the payload matches the action's schema.
 */
export function buildConfirmation<T extends ActionType>(actionType: T, payload: IActionPayloads[T]): IActionConfirmation {
	const effectLines = effectLinesFor(actionType, payload);
	const { line, reversibility } = reversibilityLine(actionType);
	return {
		effectLines,
		reversibilityLine: line,
		reversibility,
		highlight: reversibility === Reversibility.Irreversible,
	};
}

function effectLinesFor<T extends ActionType>(actionType: T, payload: IActionPayloads[T]): string[] {
	switch (actionType) {
		case ActionType.MergePr: {
			const p = payload as IActionPayloads[ActionType.MergePr];
			const lines = [`merge PR #${p.prNumber} into ${p.base} (${p.strategy})`];
			if (p.rerunChecks) { lines.push('rerun the required checks'); }
			return lines;
		}
		case ActionType.ApprovePr: {
			const p = payload as IActionPayloads[ActionType.ApprovePr];
			return [`approve PR #${p.prNumber} - this does not merge`];
		}
		case ActionType.CreatePr: {
			const p = payload as IActionPayloads[ActionType.CreatePr];
			const lines = [`open a pull request from ${p.head} into ${p.base}: "${p.title}"`];
			if (p.autoMerge) { lines.push(`enable auto-merge (${p.strategy ?? 'squash'}) so it lands once required checks pass`); }
			return lines;
		}
		case ActionType.Comment: {
			const p = payload as IActionPayloads[ActionType.Comment];
			return [`comment on #${p.targetNumber}:`, quote(p.body)];
		}
		case ActionType.AddLabels: {
			const p = payload as IActionPayloads[ActionType.AddLabels];
			const lines = [`add ${p.add.join(', ')} to #${p.targetNumber}`];
			if (p.remove && p.remove.length) { lines.push(`remove ${p.remove.join(', ')}`); }
			return lines;
		}
		case ActionType.CreateIssues: {
			const p = payload as IActionPayloads[ActionType.CreateIssues];
			return [`create ${p.issues.length} issue(s):`, ...p.issues.map(i => `- ${i.title}`)];
		}
		case ActionType.DispatchFix: {
			const p = payload as IActionPayloads[ActionType.DispatchFix];
			return [`start a fix agent for ${p.subject}`, 'opens a child Cooking task - no repo write yet'];
		}
		case ActionType.Deploy: {
			const p = payload as IActionPayloads[ActionType.Deploy];
			return [`deploy ${p.ref} to ${p.env}`];
		}
		case ActionType.GrantScope: {
			const p = payload as IActionPayloads[ActionType.GrantScope];
			return [`grant ${p.scope} to Diffy for ${p.repo}`];
		}
	}
}

function quote(body: string): string {
	const trimmed = body.length > 280 ? body.slice(0, 277) + '...' : body;
	return `"${trimmed}"`;
}
