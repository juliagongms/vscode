/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mountRoles } from '../../common/roleMount.js';
import { collectRoles, generateRoleList, IParsedSkill, parseRoleList, parseSkill } from '../../common/skillModel.js';

const SKILL_DOC = `---
id: group-issues-by-theme
roles: [issue-triage]
transfer_scope: global
version: 6
provenance: [session:abc, steer:def]
triggers: [issue.opened, issue.labeled]
---
Cluster incoming issues by shared root cause or customer ask; name the theme.
`;

function skill(id: string, roles: string[], body = 'do the thing', version = 1): IParsedSkill {
	return { frontmatter: { id, roles, version }, body };
}

suite('Inbox One - skill model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseSkill reads frontmatter fields and body', () => {
		const parsed = parseSkill(SKILL_DOC);
		assert.ok(parsed);
		assert.strictEqual(parsed!.frontmatter.id, 'group-issues-by-theme');
		assert.deepStrictEqual(parsed!.frontmatter.roles, ['issue-triage']);
		assert.strictEqual(parsed!.frontmatter.transferScope, 'global');
		assert.strictEqual(parsed!.frontmatter.version, 6);
		assert.deepStrictEqual(parsed!.frontmatter.provenance, ['session:abc', 'steer:def']);
		assert.deepStrictEqual(parsed!.frontmatter.triggers, ['issue.opened', 'issue.labeled']);
		assert.ok(parsed!.body.startsWith('Cluster incoming issues'));
	});

	test('parseSkill returns undefined without frontmatter or id', () => {
		assert.strictEqual(parseSkill('no frontmatter here'), undefined);
		assert.strictEqual(parseSkill('---\nroles: [x]\n---\nbody'), undefined);
	});

	test('parseSkill tolerates a single-string roles value', () => {
		const parsed = parseSkill('---\nid: s1\nroles: code-review\n---\nbody');
		assert.deepStrictEqual(parsed!.frontmatter.roles, ['code-review']);
	});

	test('generateRoleList groups skills by role, sorted and deterministic', () => {
		const skills = [
			skill('group-issues-by-theme', ['issue-triage']),
			skill('dedupe-issues', ['issue-triage']),
			skill('behavioral-delta', ['code-review']),
			skill('minimal-diff', ['implement-fix']),
		];
		const list = generateRoleList(skills);
		const expected = [
			'# role_list.md (generated - do not edit)',
			'code-review: [behavioral-delta]',
			'implement-fix: [minimal-diff]',
			'issue-triage: [dedupe-issues, group-issues-by-theme]',
			'',
		].join('\n');
		assert.strictEqual(list, expected);
	});

	test('generateRoleList output round-trips through parseRoleList', () => {
		const skills = [skill('a', ['r1']), skill('b', ['r1', 'r2'])];
		const map = parseRoleList(generateRoleList(skills));
		assert.deepStrictEqual(map.get('r1'), ['a', 'b']);
		assert.deepStrictEqual(map.get('r2'), ['b']);
	});

	test('a skill can declare multiple roles and appears under each', () => {
		const map = parseRoleList(generateRoleList([skill('blend', ['issue-triage', 'code-review'])]));
		assert.deepStrictEqual(map.get('issue-triage'), ['blend']);
		assert.deepStrictEqual(map.get('code-review'), ['blend']);
	});

	test('collectRoles returns distinct sorted roles', () => {
		assert.deepStrictEqual(collectRoles([skill('a', ['b-role', 'a-role']), skill('c', ['a-role'])]), ['a-role', 'b-role']);
	});
});

suite('Inbox One - role mounting', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('mountRoles mounts all role skills, marking the requested role as the primary lens', () => {
		const skills = [
			skill('triage-a', ['issue-triage'], 'AAA'),
			skill('triage-b', ['issue-triage'], 'BBB'),
			skill('review-x', ['code-review'], 'XXX'),
		];
		const result = mountRoles(['issue-triage'], skills);
		// All role skills mount so the worker can take the best action, not just triage.
		assert.deepStrictEqual(result.skillIds, ['review-x', 'triage-a', 'triage-b']);
		assert.ok(result.personaText.includes('AAA'));
		assert.ok(result.personaText.includes('XXX'));
		// The dispatched role is highlighted as primary; the others are not.
		assert.ok(result.personaText.includes('triage-a (primary lens)'));
		assert.ok(!result.personaText.includes('review-x (primary lens)'));
	});

	test('mountRoles blends multiple roles', () => {
		const skills = [skill('t', ['issue-triage'], 'T'), skill('r', ['code-review'], 'R')];
		const result = mountRoles(['issue-triage', 'code-review'], skills);
		assert.deepStrictEqual(result.skillIds, ['r', 't']);
	});

	test('framework skills are always mounted, last', () => {
		const skills = [skill('t', ['issue-triage'], 'ROLE')];
		const framework = [skill('emit-result', [], 'EMIT')];
		const result = mountRoles(['issue-triage'], skills, { frameworkSkills: framework });
		assert.ok(result.skillIds.includes('emit-result'));
		assert.ok(result.personaText.indexOf('ROLE') < result.personaText.indexOf('EMIT'), 'framework mounts last');
	});

	test('wiki patterns tagged for the roles are included', () => {
		const skills = [skill('t', ['issue-triage'], 'ROLE')];
		const result = mountRoles(['issue-triage'], skills, { wikiPatterns: [{ id: 'group-by-customer', body: 'prefer customer grouping' }] });
		assert.deepStrictEqual(result.patternIds, ['group-by-customer']);
		assert.ok(result.personaText.includes('prefer customer grouping'));
	});

	test('requesting an unknown role still mounts all available skills plus framework', () => {
		const result = mountRoles(['nonexistent'], [skill('t', ['issue-triage'], 'ROLE')], { frameworkSkills: [skill('emit-result', [], 'EMIT')] });
		assert.deepStrictEqual(result.skillIds, ['t', 'emit-result']);
		assert.ok(result.personaText.includes('ROLE'));
		assert.ok(result.personaText.includes('EMIT'));
		// The skill is mounted but not marked primary, since the requested role matches none.
		assert.ok(result.personaText.includes('- t: ROLE'));
	});

	test('mounting is deterministic regardless of input order', () => {
		const a = mountRoles(['r'], [skill('z', ['r'], 'Z'), skill('a', ['r'], 'A')]);
		const b = mountRoles(['r'], [skill('a', ['r'], 'A'), skill('z', ['r'], 'Z')]);
		assert.strictEqual(a.personaText, b.personaText);
		assert.deepStrictEqual(a.skillIds, ['a', 'z']);
	});
});
