/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describeActionCatalog } from './actionCatalog.js';
import { WorkerRole } from './eventTaxonomy.js';
import { ILogicalTask } from './inboxOneTypes.js';

/**
 * Coordinator -> worker handoff (technical spec 2.2 step 4, 2.3).
 *
 * A dispatched worker's first message is composed by the HARNESS (not the model)
 * from three deterministic parts, matching the reference control-plane handoff:
 *
 *  1. {@link WORKER_OPERATING_ENVELOPE} -- a fixed framework preamble (the
 *     worker "system prompt" equivalent): autonomy, scope discipline, read-only
 *     GitHub + surface-one-typed-action, evidence discipline, and the standing
 *     instruction to always finish via the emit-result contract. It is mounted
 *     onto EVERY worker regardless of role, exactly like the framework
 *     emit-result skill (design 5.1 / 2.3).
 *  2. The mounted skills persona (role skills + learned patterns + the
 *     emit-result contract), composed by the file store's `mountRoles`.
 *  3. {@link buildWorkerBrief} -- a rich, self-contained TASK brief authored per
 *     role: decision framing, objective, concrete steps, scope/constraints, and
 *     the evidence/acceptance expectations, ending with the standing emit-result
 *     instruction. No back-references; the worker can act from this alone.
 *
 * This module is pure and unit-testable; the file store supplies the persona and
 * the dispatcher supplies the session runtime.
 */

/**
 * The fixed operating envelope mounted onto every worker (framework-owned, like
 * emit-result). Ported from the reference `ambient_worker_system_prompt`: it is a
 * code constant, not a learnable skill, so learning can never weaken it.
 */
export const WORKER_OPERATING_ENVELOPE = [
	'You are an ambient worker session dispatched by Diffy, the always-on SDLC coordinator, to produce exactly one decision-ready result for a human reviewer. Operate under these fixed rules:',
	'',
	'- Own the full investigation, validation, and reporting for the single work item in the task brief below. Work only within its repository; do not touch unrelated repositories, branches, or code, and do not spin off unrelated work.',
	'- Use GitHub reads freely to gather evidence (issues, pull requests, commits, checks, diffs, and logs) via the `gh` CLI and `git` in your shell/bash tool -- e.g. `gh issue view`, `gh pr view`, `gh pr checks`, `gh run view --log`. Do NOT use a web-fetch/URL tool for GitHub or any other site; fetch everything through `gh`/`git`, which are already authorized. Never mutate GitHub state yourself: do not close or comment on issues, and do not create, merge, edit, or review pull requests, nor call any write API. To request a change, surface exactly one typed action in your emitted result; the host performs it under the user\'s identity only after explicit confirmation.',
	'- Ground every claim in a real receipt (a run log, a diff, a review thread, a test output). Never fabricate a receipt. If you cannot produce trustworthy evidence, emit no action and report the blocker honestly instead.',
	'- You run fully autonomously with no interactive user available. Never ask questions, request confirmation, or wait for input. Make the best-judgment decision, state any assumption in your result, and continue.',
	'- The skills mounted below are your operating guidance. Explicit instructions in the task brief take priority, and learned patterns never expand your autonomy, permissions, tools, or scope.',
	'- Always finish by following the emit-result contract exactly, ending your final message with the single machine-readable result block. The block always carries an evidence pack (the one-sentence consequence, the two to three claims you verified with receipts, and one honest "Not verified" gap line). A typed action is optional: include action_type/payload/label only when a single catalog action fully fits and you can populate its entire required payload from what you actually verified. If not, omit action_type/payload/label and put your recommendation or blocker in decisionSentence -- an evidence-only result is valid and is preferred over a malformed action, which the host rejects outright.',
].join('\n');

/**
 * The deterministic follow-up the harness relays when a worker ends a turn with
 * findings but no parseable emit-result block. Agent sessions frequently stop at
 * prose after a long investigation; this asks the worker (exactly once per
 * attempt) to finalize what it already found into the machine-readable block. It
 * authors no evidence -- the worker still produces the block from its own work.
 */
export const WORKER_FINALIZE_PROMPT = [
	'Finalize now - do not investigate further and do not ask any questions.',
	'Based only on what you have already established this session, end your reply with your emit-result: a single fenced code block tagged `inbox-one-result` containing one JSON object per the mounted emit-result contract (action_type, payload, label, title, decisionSentence, claims[], gapLine).',
	'Lead with the consequence in decisionSentence, include the two or three claims you actually verified with their receipts, and give one honest gapLine of what you did not verify. Also include a dedicated, self-contained `title`: a few-word headline that stands on its own like a subject line (e.g. "PR #12 CI bugfix complete"), NOT a prefix or shortened copy of decisionSentence.',
	'Only include action_type/payload/label when a single catalog action fully fits and you can populate its entire required payload from what you verified; otherwise omit them and put your recommendation or the blocker (with the single recovery step) in decisionSentence -- an evidence-only result is valid. Output the block as the last thing in your message.',
].join('\n');

/**
 * Wraps a human's steer/reopen instruction before it is relayed into the warm
 * worker session (technical spec 2.4). A worker often answers a steer in prose
 * without re-emitting its result, so the inbox would re-land the STALE previous
 * block and look like the steer was ignored. This appends an explicit instruction
 * to end the turn with a FRESH emit-result block, so the card always reflects the
 * updated decision. The worker still authors the evidence.
 */
export function composeSteerRelay(instruction: string): string {
	return [
		instruction.trim(),
		'',
		'After addressing this, re-run the emit-result contract and END your reply with a single fresh `inbox-one-result` block reflecting your UPDATED decision (title, decisionSentence, claims with receipts, gapLine, and a typed action or customAsk per the contract). Always emit a new block -- even if your conclusion is unchanged -- so the inbox card updates with the new result.',
	].join('\n');
}

/** Human-legible label for the event subject a worker is dispatched for. */
function describeSubject(task: ILogicalTask): string {
	const subject = task.sourceEvent.subject;
	const attached = subject.attachedTo ? `, attached to ${subject.attachedTo.kind} #${subject.attachedTo.id}` : '';
	switch (subject.kind) {
		case 'pr': return `pull request #${subject.id}`;
		case 'issue': return `issue #${subject.id}`;
		case 'issue-cluster': return `issue cluster ${subject.id}`;
		case 'check': return `failing check ${subject.id}${attached}`;
		case 'security': return `security alert ${subject.id}${attached}`;
		case 'deploy': return `deployment ${subject.id}`;
		case 'branch': return `branch ${subject.id}`;
		default: return `${subject.kind} ${subject.id}`;
	}
}

interface IRoleBrief {
	/** One-line decision framing: what human decision this worker must enable. */
	readonly framing: string;
	readonly objective: string;
	readonly steps: readonly string[];
	readonly constraints: readonly string[];
}

function roleBrief(role: WorkerRole): IRoleBrief {
	switch (role) {
		case WorkerRole.IssueTriage:
			return {
				framing: 'Decide how the incoming issue work should be organized so the team can act on it.',
				objective: 'Read the newly opened or labeled issue(s) in scope and determine how they should be organized: cluster them by shared root cause or customer ask, and identify any single theme that is ready to be fixed directly.',
				steps: [
					'Read each in-scope issue end to end: title, body, labels, and recent comments.',
					'Group issues that describe the same underlying problem (same root cause, reproduction, or customer request); prefer a few strong themes over many weak ones.',
					'Name each theme in short, specific, actionable language a human can act on (for example "session-expiry on mobile Safari", not "bugs").',
					'Cite the exact issue numbers that belong to each theme as receipts, and note any uncertain membership so the human can re-split it.',
				],
				constraints: [
					'Group only when the symptoms and requested outcomes genuinely align; preserve distinct edge cases rather than over-merging.',
					'Rank customer impact using authoritative issue, label, and assignee metadata, not speculation.',
				],
			};
		case WorkerRole.CodeReview:
			return {
				framing: 'Decide whether this pull request is safe to approve, or exactly what must change first.',
				objective: 'Review this pull request for consequence and correctness and determine whether it is safe to approve, or precisely what must change before it can be.',
				steps: [
					'Read the pull request end to end: description, full diff, any linked issue, and the CI checks.',
					'Assess the correctness, test coverage, and risk of the actual change - not its formatting.',
					'Confirm the checks that matter are green, naming each one and its conclusion.',
					'Decide: approve, or list the specific high-confidence problems that block approval, each paired with the evidence supporting it.',
				],
				constraints: [
					'Report only high-confidence problems and show the concrete evidence for each conclusion.',
					'Do not raise style, formatting, or subjective nits; review consequence, not cosmetics.',
				],
			};
		case WorkerRole.ImplementFix:
		default:
			return {
				framing: 'Decide whether the failure is fixed and the change is safe to land.',
				objective: 'Reproduce the failure, produce a minimal verified fix on a work branch, and confirm the previously failing check now passes.',
				steps: [
					'Read the failure: check name, conclusion, annotations, and output, plus the pull request or branch it belongs to.',
					'Reproduce the failure with an exact, named command before changing anything.',
					'Make the smallest change that addresses the root cause, reusing existing patterns in the codebase.',
					'Re-run the exact check or command and confirm it now passes, capturing that run as a receipt.',
				],
				constraints: [
					'Separate diagnosis from remediation, and state the exact failing scope plus any paths you did not verify.',
					'Keep the change surgical and do not expand scope. Commit only to a work branch; never target the default branch directly - surface a typed action for any GitHub change.',
				],
			};
	}
}

/**
 * Builds the self-contained TASK brief for a worker (technical spec 2.2 step 4).
 * Rich, role-specific, and free of back-references, so the worker can act from
 * this brief plus its mounted skills alone. Deterministic and pure.
 */
export function buildWorkerBrief(role: WorkerRole, task: ILogicalTask): string {
	const repo = task.repo ?? 'the target repository';
	const trigger = `${task.sourceEvent.type}${task.sourceEvent.action ? '.' + task.sourceEvent.action : ''}`;
	const rb = roleBrief(role);

	const lines: string[] = [
		`# Task: ${rb.framing}`,
		'',
		'## Work item',
		`- Repository: ${repo}`,
		`- Subject: ${describeSubject(task)}`,
		`- Trigger: ${trigger}`,
		'',
		'## Objective',
		rb.objective,
		'',
		'## Decide the best action',
		`You were dispatched with the ${role} lens, but you are not limited to it: assess THIS work item and take the action that is genuinely best for it. If implementing a fix is the right move, do it -- make the smallest verified change on a work branch (never the default branch), then surface the corresponding typed action (for example, open a pull request) for the human to accept. You may equally review, triage/group, or -- when only a human can decide -- surface a question. Use the mounted skill that fits the action you choose. Do not force a triage-only result when the item clearly warrants implementation.`,
		'',
		'## How to proceed',
		...rb.steps.map((s, i) => `${i + 1}. ${s}`),
		'',
		'## Scope and constraints',
		...rb.constraints.map(c => `- ${c}`),
		'',
		'## Action catalog',
		'A typed action is OPTIONAL. If you propose one, choose exactly one action_type below and fill its payload exactly: include every required field and use only values from any finite set shown (e.g. a merge strategy). If you cannot fully populate a payload from what you verified, propose no action (an evidence-only result is valid and preferred over a malformed one).',
		describeActionCatalog(),
		'',
		'## Evidence and acceptance',
		'- `title`: a dedicated, self-contained few-word headline that stands on its own like a subject line -- for example "PR #12 CI bugfix complete", "Merge issues relating to cursor bug", "Flaky auth test now passing". It is NOT a shortened copy or prefix of decisionSentence; write it as its own succinct phrase (about 3-6 words). This is the inbox list entry.',
		'- `decisionSentence`: separately, the single most important consequence/recommendation for the human in one full sentence (the fuller line shown when the item is opened). Do not just restate the title.',
		'- Provide two to three claims, each naming a concrete quantity and its verification method (an exact command, a named CI check and its conclusion, or the files changed with counts), paired with a real receipt link.',
		'- State exactly one honest "Not verified" line covering the concrete, decision-relevant gap you did not confirm; omit speculative edge cases.',
		'- Propose exactly one typed action from the catalog above ONLY when a single action fully fits and you can populate its entire required payload from what you verified. If none fits but a human decision is needed, use action_type "other" with a `customAsk` (your question/recommendation, answered via Steer). Otherwise propose no action.',
		'',
		'## Final step',
		'As the final step, follow the mounted emit-result skill and produce, as separate fields, the dedicated short `title`, the fuller `decisionSentence`, the evidence pack, and a label of at most three to four words, ending your final message with the single `inbox-one-result` JSON block. Include a typed action only when you can fully populate its required payload from the catalog above; otherwise omit action_type/payload/label and lead with your recommendation in decisionSentence. Do not invent action types or fabricate receipts; the host validates the action against the catalog and rejects anything malformed, so an evidence-only result is safer than a half-specified action.',
	];
	return lines.join('\n');
}

/**
 * Composes the worker's first message from the fixed operating envelope, the
 * mounted skills persona, and the task brief (technical spec 2.2-2.3). The
 * harness owns this composition; `personaText` comes from the file store's
 * `mountRoles` (role skills + learned patterns + the emit-result contract) and
 * may be empty when no skills match the role (the brief still stands alone).
 */
export function composeWorkerFirstMessage(personaText: string, brief: string): string {
	const parts: string[] = [WORKER_OPERATING_ENVELOPE];
	const persona = personaText.trim();
	if (persona.length > 0) {
		parts.push(persona);
	}
	parts.push('---', brief.trim());
	return parts.join('\n\n');
}
