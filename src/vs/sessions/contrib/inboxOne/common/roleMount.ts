/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IParsedSkill } from './skillModel.js';

/**
 * Role mounting / persona composition (design 5.2, technical spec 2.2 step 3).
 *
 * `mount_roles([...])` selects the skills tagged with the requested roles and
 * composes the worker persona. Role skills are ATTACHED to the session through
 * the harness Skills integration (directory discovery), so this references them
 * by name + purpose rather than inlining their full bodies -- the worker loads a
 * skill's methodology on demand by name, and the first message stays small as
 * skills accumulate. Learned wiki patterns (not discoverable skills) and the
 * small, mandatory framework output contract are inlined in full. Deterministic;
 * the harness -- not the model -- selects/attaches the skills. Framework skills
 * are mounted unconditionally, independent of role selection (design 5.1).
 *
 * This module is the pure composition core; the file-backed store supplies the
 * parsed skills and wiki patterns and projects the role skills into the harness
 * discovery directory.
 */

export interface IWikiPatternSnippet {
	readonly id: string;
	readonly body: string;
}

export interface IMountResult {
	/** The composed persona text (system-prompt fragment). */
	readonly personaText: string;
	/** Skill ids that were mounted, in order. */
	readonly skillIds: readonly string[];
	/** Wiki pattern ids that were included. */
	readonly patternIds: readonly string[];
}

export interface IMountOptions {
	/** Framework skills mounted onto EVERY worker regardless of role (e.g. emit-result). */
	readonly frameworkSkills?: readonly IParsedSkill[];
	/** Wiki patterns tagged for the selected roles (design 5.3, retrieved via index.md). */
	readonly wikiPatterns?: readonly IWikiPatternSnippet[];
	/**
	 * Skill selection policy. When omitted or `true` (the current default), EVERY
	 * role skill is mounted so the worker has the full methodology set and can pick
	 * the best action for the item -- the dispatched role is only highlighted as the
	 * "(primary lens)". Set `false` to scope the mount to just the skills tagged with
	 * `roleNames` (the classic role-boxed persona). Kept as a first-class, tested
	 * option so a caller that wants a single-role persona can ask for one.
	 */
	readonly mountAllRoleSkills?: boolean;
}

/**
 * Composes persona text for the requested roles from the available skills.
 *
 * By default ALL role skills are mounted (not just the dispatched role's) so the
 * worker has the full methodology set and can take the best action for the item;
 * the dispatched role is highlighted as the primary lens. Pass
 * `mountAllRoleSkills: false` to scope the persona to only `roleNames`. Ordered by
 * skill id for stability; then framework skills (always), then tagged wiki
 * patterns.
 */
export function mountRoles(roleNames: readonly string[], skills: readonly IParsedSkill[], options: IMountOptions = {}): IMountResult {
	const requested = new Set(roleNames);
	// Mount ALL role skills by default, not just the dispatched role's, so the
	// worker has the full methodology set (triage, implement, review, ...) and can
	// take the best action for THIS item rather than being boxed into its dispatch
	// lens. The dispatched role is still highlighted as the primary lens. When a
	// caller opts into `mountAllRoleSkills: false`, scope to the requested roles.
	const scopeToRoles = options.mountAllRoleSkills === false;
	const selected = skills
		.filter(s => !scopeToRoles || s.frontmatter.roles.some(r => requested.has(r)))
		.slice()
		.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));

	const framework = (options.frameworkSkills ?? []).slice();
	const patterns = (options.wikiPatterns ?? []).slice();

	const sections: string[] = [];
	const skillIds: string[] = [];

	// Role skills are ATTACHED to the worker session through the harness Skills
	// integration (discovered from the skills directory), so reference them by name
	// and purpose here instead of inlining their full bodies -- the worker loads a
	// skill's full methodology on demand by name. This keeps the first message from
	// ballooning as skills accumulate; only the (small, mandatory) framework output
	// contract below is inlined in full.
	if (selected.length) {
		const refs = selected.map(s => {
			const primary = s.frontmatter.roles.some(r => requested.has(r));
			return `- ${s.frontmatter.id}${primary ? ' (primary lens)' : ''}: ${skillPurpose(s.body)}`;
		}).join('\n');
		sections.push(`## Your skills for this task\nAll of these skills are attached to your session -- open any by name for its full methodology. Your dispatched lens is marked "(primary lens)", but assess THIS item and apply whichever skill fits the best action for it (triage, implement a fix, review, ...):\n${refs}`);
		for (const skill of selected) {
			skillIds.push(skill.frontmatter.id);
		}
	}

	if (patterns.length) {
		const patternText = patterns.map(p => `### pattern: ${p.id}\n${p.body.trim()}`).join('\n\n');
		sections.push(`## Learned patterns\n${patternText}`);
	}

	// The framework output contract is inlined in full (small, authoritative, and
	// followed exactly), mounted last so it is the final instruction the worker
	// reads (design 5.1 / 2.3).
	for (const skill of framework) {
		sections.push(renderSkillSection(skill));
		skillIds.push(skill.frontmatter.id);
	}

	return {
		personaText: sections.join('\n\n').trim(),
		skillIds,
		patternIds: patterns.map(p => p.id),
	};
}

/** The first meaningful line of a skill body (its heading), used as a one-line reference purpose. */
function skillPurpose(body: string): string {
	for (const raw of body.split('\n')) {
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		return line.startsWith('# ') ? line.slice(2).trim() : line;
	}
	return '';
}

function renderSkillSection(skill: IParsedSkill): string {
	return `## skill: ${skill.frontmatter.id}\n${skill.body.trim()}`;
}
