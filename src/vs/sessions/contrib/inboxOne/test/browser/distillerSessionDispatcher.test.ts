/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChatSessionsService } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { GestureKind } from '../../common/inboxOneTypes.js';
import { IInboxOneFileStore, IStoredSkill } from '../../common/inboxOneFileStore.js';
import { IExperienceRecord, LearningTarget } from '../../common/learningLoop.js';
import { ILaunchOptions, IInboxOneSessionLauncher } from '../../browser/inboxOneSessionLauncher.js';
import { DistillerSessionDispatcher } from '../../browser/distillerSessionDispatcher.js';

function storedSkill(id: string, roles: string[], opts: { isCoordinator?: boolean; isFramework?: boolean } = {}): IStoredSkill {
	return {
		path: `${id}/SKILL.md`,
		isFramework: opts.isFramework ?? false,
		isCoordinator: opts.isCoordinator ?? false,
		frontmatter: { id, roles, version: 1 },
		body: `Body of ${id}.`,
	} as unknown as IStoredSkill;
}

class FakeLauncher {
	readonly launched: Array<{ firstMessage: string; options: ILaunchOptions }> = [];
	launchResult: ISession | undefined;
	async launch(firstMessage: string, options: ILaunchOptions): Promise<ISession | undefined> {
		this.launched.push({ firstMessage, options });
		return this.launchResult;
	}
	asService(): IInboxOneSessionLauncher { return this as unknown as IInboxOneSessionLauncher; }
}

class FakeFileStore {
	skills: IStoredSkill[] = [
		storedSkill('emit-result', [], { isFramework: true }),
		storedSkill('group-issues-by-theme', ['issue-triage']),
		storedSkill('coordinator-routing', ['coordinator'], { isCoordinator: true }),
	];
	readonly written: Array<{ id: string; content: string }> = [];
	async listSkills(): Promise<readonly IStoredSkill[]> { return this.skills; }
	async writeSkill(id: string, content: string): Promise<void> { this.written.push({ id, content }); }
	asService(): IInboxOneFileStore { return this as unknown as IInboxOneFileStore; }
}

function record(overrides: Partial<IExperienceRecord> = {}): IExperienceRecord {
	return {
		resolutionId: 'res-1', taskId: 'task-1', role: 'issue-triage', repo: 'acme/api',
		gesture: GestureKind.Dismiss, resolvedAt: 0, ...overrides,
	};
}

suite('Inbox One - DistillerSessionDispatcher', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function make(launcher: FakeLauncher, fileStore: FakeFileStore) {
		return disposables.add(new DistillerSessionDispatcher(
			launcher.asService(), fileStore.asService(), {} as unknown as IChatSessionsService, disposables.add(new NullLogService()),
		));
	}

	test('accept/steer brief the ROLE skill that produced the result', async () => {
		const launcher = new FakeLauncher();
		const fileStore = new FakeFileStore();
		const dispatcher = make(launcher, fileStore);

		await dispatcher.distill(record({ gesture: GestureKind.Accept }), LearningTarget.ReinforceRoleSkill);

		assert.strictEqual(launcher.launched.length, 1);
		const brief = launcher.launched[0].firstMessage;
		assert.ok(brief.includes('id: group-issues-by-theme'), 'briefs the role skill');
		assert.ok(!brief.includes('id: coordinator-routing'));
	});

	test('dismiss briefs the COORDINATOR skill, not the role skill', async () => {
		// A dismiss means "surfacing this was wrong", so the lesson belongs to
		// Diffy's own priority/dispatch skill -- the worker's role skill did
		// nothing wrong and must not be rewritten.
		const launcher = new FakeLauncher();
		const fileStore = new FakeFileStore();
		const dispatcher = make(launcher, fileStore);

		await dispatcher.distill(record(), LearningTarget.CoordinatorSkill);

		assert.strictEqual(launcher.launched.length, 1);
		const brief = launcher.launched[0].firstMessage;
		assert.ok(brief.includes('id: coordinator-routing'), 'briefs the coordinator skill');
		assert.ok(!brief.includes('id: group-issues-by-theme'), 'never briefs the role skill for a coordinator target');
	});

	test('never targets a framework skill', async () => {
		const launcher = new FakeLauncher();
		const fileStore = new FakeFileStore();
		// A framework skill that also claims the role must still be skipped.
		fileStore.skills = [storedSkill('emit-result', ['issue-triage'], { isFramework: true })];
		const dispatcher = make(launcher, fileStore);

		await dispatcher.distill(record({ gesture: GestureKind.Accept }), LearningTarget.ReinforceRoleSkill);

		assert.strictEqual(launcher.launched.length, 1);
		assert.ok(launcher.launched[0].firstMessage.includes('no existing skill for this target'));
	});

	test('still dispatches (with no current skill) when the target skill is missing', async () => {
		const launcher = new FakeLauncher();
		const fileStore = new FakeFileStore();
		fileStore.skills = [storedSkill('group-issues-by-theme', ['issue-triage'])];
		const dispatcher = make(launcher, fileStore);

		await dispatcher.distill(record(), LearningTarget.CoordinatorSkill);

		assert.strictEqual(launcher.launched.length, 1);
		assert.ok(launcher.launched[0].firstMessage.includes('no existing skill'));
		assert.strictEqual(fileStore.written.length, 0);
	});

	test('launches the distiller as a distiller-tagged session keyed by resolution id', async () => {
		const launcher = new FakeLauncher();
		launcher.launchResult = {
			resource: URI.parse('agent-host-session://acme/distiller-1'),
			status: constObservable(SessionStatus.InProgress),
			mainChat: constObservable({} as never),
		} as unknown as ISession;
		const fileStore = new FakeFileStore();
		const dispatcher = make(launcher, fileStore);

		await dispatcher.distill(record(), LearningTarget.CoordinatorSkill);

		const options = launcher.launched[0].options;
		assert.strictEqual(options.activity, 'distiller');
		assert.strictEqual(options.metadata?.inboxOneDistiller, 'res-1');
	});
});
