/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParsedSkill } from '../../common/skillModel.js';
import { mountRoles } from '../../common/roleMount.js';

function skill(id: string, roles: string[], heading: string): IParsedSkill {
	return { frontmatter: { id, roles }, body: `# ${heading}\nMethodology for ${id}.` };
}

const SKILLS: IParsedSkill[] = [
	skill('group-issues-by-theme', ['issue-triage'], 'Group issues by theme'),
	skill('flaky-test-repro', ['implement-fix'], 'Reproduce a flaky test'),
	skill('behavioral-delta', ['code-review'], 'Review behavioral delta'),
];

const FRAMEWORK: IParsedSkill[] = [skill('emit-result', [], 'Emit result')];

suite('Inbox One - mountRoles', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('by default mounts EVERY role skill, marking the dispatched role as the primary lens', () => {
		const result = mountRoles(['issue-triage'], SKILLS, { frameworkSkills: FRAMEWORK });
		// All role skills present, so the worker can act beyond its dispatch lens.
		assert.deepStrictEqual(
			[...result.skillIds].sort(),
			['behavioral-delta', 'emit-result', 'flaky-test-repro', 'group-issues-by-theme'],
		);
		// Only the dispatched role's skill is the primary lens.
		assert.ok(result.personaText.includes('group-issues-by-theme (primary lens)'));
		assert.ok(!result.personaText.includes('behavioral-delta (primary lens)'));
	});

	test('mountAllRoleSkills:false scopes the persona to only the requested role(s)', () => {
		const result = mountRoles(['issue-triage'], SKILLS, { frameworkSkills: FRAMEWORK, mountAllRoleSkills: false });
		// Only the requested role's skill (+ the always-on framework contract).
		assert.deepStrictEqual([...result.skillIds].sort(), ['emit-result', 'group-issues-by-theme']);
		assert.ok(!result.personaText.includes('behavioral-delta'));
		assert.ok(!result.personaText.includes('flaky-test-repro'));
	});

	test('always mounts framework skills regardless of role selection', () => {
		const all = mountRoles(['code-review'], SKILLS, { frameworkSkills: FRAMEWORK });
		const scoped = mountRoles(['code-review'], SKILLS, { frameworkSkills: FRAMEWORK, mountAllRoleSkills: false });
		assert.ok(all.skillIds.includes('emit-result'));
		assert.ok(scoped.skillIds.includes('emit-result'));
	});

	test('multiple requested roles are all marked primary when scoped', () => {
		const result = mountRoles(['issue-triage', 'code-review'], SKILLS, { mountAllRoleSkills: false });
		assert.deepStrictEqual([...result.skillIds].sort(), ['behavioral-delta', 'group-issues-by-theme']);
	});
});
