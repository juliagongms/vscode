/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OTHER_ACTION, validateAction } from './actionCatalog.js';
import { EvidenceRung, IEvidenceClaim, IEvidenceFreshness, IEvidencePack, IPrimaryAction } from './inboxOneTypes.js';

/**
 * Host-side validation of a worker's emitted result (technical spec 2.3, 7.1).
 *
 * The worker follows the baked-in emit-result contract and produces a structured
 * candidate: a typed action (action_type + payload), a short worker-authored
 * label, and an evidence pack (consequence + claims + gap). The HOST -- not the
 * model -- validates the action against the catalog and normalizes the evidence.
 * An out-of-catalog action, malformed payload, or missing mandatory evidence is
 * rejected so it surfaces as a failed attempt, never executed.
 *
 * The maximum label length keeps the worker-authored button label to a few words
 * (design 3.4). The label is display-only and never affects execution.
 */

/** Maximum words allowed in a worker-authored action label (design 3.4: <= 3-4 words). */
export const MAX_LABEL_WORDS = 4;
/** Evidence packs lead with a consequence and carry 2-3 grounded claims (design 3.3). */
export const MIN_EVIDENCE_CLAIMS = 1;
export const MAX_EVIDENCE_CLAIMS = 4;

/**
 * Caps an over-long claim list to {@link MAX_EVIDENCE_CLAIMS}, keeping the
 * STRONGEST claims by rung and preserving their original relative order. Used so
 * a worker that over-delivers (5+ grounded claims) has its pack trimmed rather
 * than rejected -- the same "clean, don't fail" philosophy as {@link cleanLabel}
 * for over-long labels. Zero claims is still a genuine content failure and is
 * rejected upstream, not capped here.
 */
function capClaims(claims: readonly IEvidenceClaim[], max: number): IEvidenceClaim[] {
	if (claims.length <= max) {
		return claims.slice();
	}
	const keep = new Set(
		claims.map((c, i) => ({ c, i }))
			.sort((a, b) => (b.c.rung - a.c.rung) || (a.i - b.i))
			.slice(0, max)
			.map(x => x.i),
	);
	return claims.filter((_, i) => keep.has(i));
}

/** The raw, untrusted result a worker emits (as parsed from its structured output). */
export interface IRawWorkerResult {
	readonly actionType?: string;
	readonly payload?: unknown;
	readonly label?: string;
	/** A short headline (a few words) for the inbox list title, distinct from the full decisionSentence. */
	readonly title?: string;
	readonly decisionSentence?: string;
	/** The worker's specific ask for the human when actionType is `other` (answered via Steer). */
	readonly customAsk?: string;
	readonly claims?: readonly IRawClaim[];
	readonly gapLine?: string;
	readonly freshness?: IEvidenceFreshness;
}

export interface IRawClaim {
	readonly text?: string;
	readonly receiptLink?: string;
	readonly rung?: number;
}

export interface IEmitResultAccepted {
	readonly ok: true;
	readonly evidence: Omit<IEvidencePack, 'revision'>;
}

export interface IEmitResultRejected {
	readonly ok: false;
	readonly problems: readonly string[];
}

export type IEmitResultOutcome = IEmitResultAccepted | IEmitResultRejected;

function coerceRung(rung: number | undefined): EvidenceRung {
	// The rung is host-authoritative; a model-supplied number is clamped to a
	// known rung and defaults to the lowest (illustrative) when absent/invalid.
	const valid = [
		EvidenceRung.Illustrative, EvidenceRung.SingleRun, EvidenceRung.ReproducibleTest,
		EvidenceRung.Invariant, EvidenceRung.SourceLineage, EvidenceRung.ExecutableModel, EvidenceRung.Formal,
	];
	return typeof rung === 'number' && valid.includes(rung) ? rung : EvidenceRung.Illustrative;
}

/**
 * Validates and normalizes a raw worker result into a store-ready evidence pack,
 * or rejects it with a list of problems. Does not execute anything.
 */
export function validateWorkerResult(raw: IRawWorkerResult): IEmitResultOutcome {
	const problems: string[] = [];

	// --- evidence pack (mandatory) ---
	if (typeof raw.decisionSentence !== 'string' || raw.decisionSentence.trim().length === 0) {
		problems.push('decisionSentence must be a non-empty string');
	}
	if (typeof raw.gapLine !== 'string' || raw.gapLine.trim().length === 0) {
		problems.push('gapLine (the mandatory "Not verified" line) must be a non-empty string');
	}
	const rawClaims = Array.isArray(raw.claims) ? raw.claims : [];
	if (rawClaims.length < MIN_EVIDENCE_CLAIMS) {
		problems.push(`evidence must have at least ${MIN_EVIDENCE_CLAIMS} claim`);
	}
	const claims: IEvidenceClaim[] = [];
	rawClaims.forEach((c, i) => {
		if (typeof c.text !== 'string' || c.text.trim().length === 0) {
			problems.push(`claims[${i}].text must be a non-empty string`);
			return;
		}
		claims.push({ text: c.text.trim(), receiptLink: c.receiptLink, rung: coerceRung(c.rung) });
	});

	// --- primary action (optional). The evidence pack is the mandatory core; a
	// typed action is a bonus. An action becomes a one-click button ONLY when it is
	// a valid catalog action with a valid payload. `other`, an out-of-catalog action,
	// or a malformed payload all DEGRADE to a custom ask the human answers via Steer:
	// the model's suggestion is surfaced and the evidence still lands. The result is
	// never rejected over the action, so a good investigation is never lost and a
	// task never hangs waiting for a well-formed action. ---
	let primaryAction: IPrimaryAction | undefined;
	let customAsk: string | undefined;
	const decisionText = typeof raw.decisionSentence === 'string' ? raw.decisionSentence.trim() : '';
	const proposesAction = raw.actionType !== undefined || raw.payload !== undefined || raw.label !== undefined;
	if (raw.actionType === OTHER_ACTION) {
		const ask = typeof raw.customAsk === 'string' ? raw.customAsk.trim() : '';
		customAsk = ask.length > 0 ? ask : decisionText;
	} else if (proposesAction) {
		const actionType = typeof raw.actionType === 'string' ? raw.actionType : '';
		const validation = validateAction(actionType, raw.payload);
		if (validation.valid) {
			// Safe: validateAction confirmed actionType is a known ActionType. The
			// label is display-only, so a missing/over-long one is cleaned, not rejected.
			primaryAction = { label: cleanLabel(raw.label, actionType), actionType: actionType as IPrimaryAction['actionType'], payload: raw.payload };
		} else {
			// Out-of-catalog action_type or malformed payload: surface the model's
			// suggestion and let the human Steer, rather than failing the result.
			customAsk = suggestionAsk(raw, actionType, decisionText);
		}
	}

	if (problems.length > 0) {
		return { ok: false, problems };
	}

	const evidence: Omit<IEvidencePack, 'revision'> = {
		title: shortTitle(raw.title),
		decisionSentence: raw.decisionSentence!.trim(),
		customAsk,
		claims: capClaims(claims, MAX_EVIDENCE_CLAIMS),
		gapLine: raw.gapLine!.trim(),
		freshness: raw.freshness ?? { computedAt: Date.now() },
		primaryAction,
	};
	return { ok: true, evidence };
}

/** A clean, short display label for a valid action: the worker's, trimmed to {@link MAX_LABEL_WORDS}, else the humanized action type. */
function cleanLabel(rawLabel: string | undefined, actionType: string): string {
	const t = typeof rawLabel === 'string' ? rawLabel.trim() : '';
	if (t.length === 0) {
		return humanizeActionType(actionType);
	}
	const words = t.split(/\s+/).filter(Boolean);
	return words.length <= MAX_LABEL_WORDS ? t : words.slice(0, MAX_LABEL_WORDS).join(' ');
}

/** Turns an action_type token into a human label, e.g. `add_labels` -> `Add Labels`. */
function humanizeActionType(actionType: string): string {
	const words = actionType.split(/[_\s]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1));
	return words.length ? words.join(' ') : 'Run action';
}

/** The custom ask shown when a worker proposed an action that is not a valid one-click catalog action. */
function suggestionAsk(raw: IRawWorkerResult, actionType: string, decisionText: string): string {
	const suggestion = (typeof raw.label === 'string' && raw.label.trim()) || (actionType ? humanizeActionType(actionType) : '');
	if (suggestion) {
		return `Diffy suggested an action -- "${suggestion}" -- that is not a one-click catalog action here. Steer to tell Diffy how to proceed.`;
	}
	return decisionText || 'Diffy proposed an action that needs your decision. Steer to proceed.';
}

/**
 * Normalizes a worker-authored list title: trims it. The title is a dedicated,
 * self-contained field the worker authors as its own short headline (the brief
 * requires this and forbids a decisionSentence prefix), so the host does not
 * truncate it. Returns `undefined` when absent, so the host falls back to the
 * generic subject label rather than a slice of the decisionSentence.
 */
function shortTitle(raw: string | undefined): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}
