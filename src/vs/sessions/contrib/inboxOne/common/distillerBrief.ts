/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExperienceRecord, LearningTarget } from './learningLoop.js';

/**
 * The distiller brief + result parsing (design 6.2). The distiller is a stock
 * agent session: given the resolved experience and the current role skill, it
 * consolidates the lesson and proposes a versioned skill update. Because the
 * agent runs in a repo worktree (not the Inbox One file store), the current skill
 * is passed IN the brief and the proposed update comes BACK in a fenced block the
 * host applies -- keeping the semantic work in the agent and the durable write on
 * the host (idempotent, versioned, rollbackable).
 */

/** The fence tag the distiller emits its proposed SKILL.md in. */
export const DISTILLER_SKILL_FENCE = 'inbox-one-skill';

function targetGuidance(target: LearningTarget): string {
	switch (target) {
		case LearningTarget.ReinforceRoleSkill:
			return 'The human accepted the result. Reinforce what worked: make the winning approach more explicit/first-class in the skill.';
		case LearningTarget.RoleSkillLesson:
			return 'The human STEERED the result. Their steering is the primary signal -- turn the correction into a concrete lesson and fold it into the skill.';
		case LearningTarget.CoordinatorSkill:
			return 'The human dismissed/deprioritised this. Update the coordinator priority/dispatch skill so this kind of work is surfaced less or routed differently.';
	}
}

/**
 * Builds the self-contained distiller brief. Includes the resolved experience,
 * the target guidance, the current skill (when known), and the exact output
 * contract (emit the full proposed SKILL.md in an {@link DISTILLER_SKILL_FENCE}
 * block, or emit nothing to leave the skill unchanged).
 */
export function buildDistillerBrief(record: IExperienceRecord, target: LearningTarget, currentSkill: string | undefined): string {
	const lines: string[] = [
		'You are the Inbox One distiller. A task just resolved; distill the lesson and, only if warranted, propose a versioned update to the skill shown below.',
		'',
		`Resolution: gesture=${record.gesture}, role=${record.role ?? 'unknown'}, repo=${record.repo ?? 'n/a'}, outcome=${record.outcome ?? 'n/a'}.`,
		targetGuidance(target),
	];
	if (record.steeringTranscript && record.steeringTranscript.trim()) {
		lines.push('', 'Steering conversation (the primary learning signal):', record.steeringTranscript.trim());
	}
	if (currentSkill && currentSkill.trim()) {
		lines.push('', 'Current skill (SKILL.md):', '```', currentSkill.trim(), '```');
	} else {
		lines.push('', 'There is no existing skill for this target yet; you may propose a new one.');
	}
	lines.push(
		'',
		'Output contract: if (and only if) an update is warranted, emit the FULL proposed SKILL.md as the last thing in your message, in a single fenced block tagged',
		'`' + DISTILLER_SKILL_FENCE + '` (keep the YAML frontmatter, bump nothing -- the host versions it). Do not modify framework skills. If no change is warranted, emit no such block.',
	);
	return lines.join('\n');
}

const FENCE_RE = new RegExp('```' + DISTILLER_SKILL_FENCE + '\\s*([\\s\\S]*?)```', 'g');

/**
 * Extracts the proposed SKILL.md from the distiller's final message, or
 * `undefined` when the distiller proposed no change. Takes the last block if
 * several are present. Rejects an empty/frontmatter-less body defensively.
 */
export function parseProposedSkill(text: string): string | undefined {
	if (!text) {
		return undefined;
	}
	let match: RegExpExecArray | null;
	let last: string | undefined;
	FENCE_RE.lastIndex = 0;
	while ((match = FENCE_RE.exec(text)) !== null) {
		last = match[1];
	}
	if (last === undefined) {
		return undefined;
	}
	const body = last.trim();
	// A valid SKILL.md leads with YAML frontmatter; reject anything else so a
	// malformed proposal never clobbers a good skill.
	if (!body.startsWith('---') || body.length < 8) {
		return undefined;
	}
	return body;
}
