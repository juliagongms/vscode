/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IChatSessionsService } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsRecentWorkspacesService } from '../../../../services/sessions/browser/sessionsRecentWorkspacesService.js';
import { InboxOneSessionLauncher } from '../../browser/inboxOneSessionLauncher.js';

function fakeSession(ref: string): ISession {
	return { resource: URI.parse(ref), mainChat: constObservable({} as never) } as unknown as ISession;
}

class FakeSessions {
	/** URIs that can host a session. */
	servable = new Set<string>();
	quickChatAvailable = false;
	/** The folder's session types (first is the preferred one the composer would pick). */
	sessionTypes: Array<{ providerId: string; sessionType: { id: string } }> = [{ providerId: 'local-agent-host', sessionType: { id: 'copilotcli' } }];
	created: Array<{ folder: URI | undefined; query: string; title?: string; metadata?: Record<string, unknown>; providerId?: string; sessionTypeId?: string; permissionLevel?: string; autopilotConfig?: string }> = [];
	relayed: Array<{ ref: string; query: string }> = [];
	sessionsByRef = new Map<string, ISession>();
	createResult: ISession | undefined;

	isNewSessionTargetAvailable(folder: URI): boolean { return this.servable.has(folder.toString()); }
	isQuickChatTargetAvailable(): boolean { return this.quickChatAvailable; }
	getSessionTypesForFolder(_folder: URI): Array<{ providerId: string; sessionType: { id: string } }> { return this.sessionTypes; }
	async createAndSendNewChatRequest(folder: URI, options: { query: string; title?: string }, createOptions?: { metadata?: Record<string, unknown>; providerId?: string; sessionTypeId?: string; permissionLevel?: string; automationConfiguration?: { permissionLevel?: string } }): Promise<ISession | undefined> {
		this.created.push({ folder, query: options.query, title: options.title, metadata: createOptions?.metadata, providerId: createOptions?.providerId, sessionTypeId: createOptions?.sessionTypeId, permissionLevel: createOptions?.permissionLevel, autopilotConfig: createOptions?.automationConfiguration?.permissionLevel });
		return this.createResult;
	}
	async createAndSendQuickChatRequest(options: { query: string; title?: string }, createOptions?: { metadata?: Record<string, unknown>; providerId?: string; sessionTypeId?: string; permissionLevel?: string; automationConfiguration?: { permissionLevel?: string } }): Promise<ISession | undefined> {
		this.created.push({ folder: undefined, query: options.query, title: options.title, metadata: createOptions?.metadata, providerId: createOptions?.providerId, sessionTypeId: createOptions?.sessionTypeId, permissionLevel: createOptions?.permissionLevel, autopilotConfig: createOptions?.automationConfiguration?.permissionLevel });
		return this.createResult;
	}
	getSession(uri: URI): ISession | undefined { return this.sessionsByRef.get(uri.toString()); }
	async sendRequest(session: ISession, _chat: unknown, options: { query: string }): Promise<void> {
		this.relayed.push({ ref: session.resource.toString(), query: options.query });
	}
	asService(): ISessionsManagementService { return this as unknown as ISessionsManagementService; }
}

class FakeChatSessions {
	readonly retained: string[] = [];
	async getOrCreateChatSession(resource: URI): Promise<{ readonly sessionResource: URI; readonly history: never[]; dispose(): void }> {
		this.retained.push(resource.toString());
		return { sessionResource: resource, history: [], dispose() { } };
	}
	asService(): IChatSessionsService { return this as unknown as IChatSessionsService; }
}

function fakeRecents(roots: URI[]): ISessionsRecentWorkspacesService {
	return {
		getRecentWorkspaces: () => roots.map(root => ({ workspace: { folders: [{ root }] }, providerId: 'p', checked: false })),
	} as unknown as ISessionsRecentWorkspacesService;
}

function fakeWorkspace(folder: URI | undefined): IWorkspaceContextService {
	return { getWorkspace: () => ({ folders: folder ? [{ uri: folder }] : [] }) } as unknown as IWorkspaceContextService;
}

suite('Inbox One - InboxOneSessionLauncher', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function make(sessions: FakeSessions, localFolder: URI | undefined, recents: URI[], chatSessions = new FakeChatSessions()) {
		return {
			launcher: new InboxOneSessionLauncher(sessions.asService(), fakeRecents(recents), fakeWorkspace(localFolder), disposables.add(new TestStorageService()), chatSessions.asService(), disposables.add(new NullLogService())),
			chatSessions,
		};
	}

	test('launches in the open workspace folder when it can host a session', async () => {
		const sessions = new FakeSessions();
		const folder = URI.file('/repo');
		sessions.servable.add(folder.toString());
		sessions.createResult = fakeSession('agent-host-session://worker-1');
		const { launcher, chatSessions } = make(sessions, folder, []);

		const session = await launcher.launch('hello', { title: 'T', activity: 'worker', metadata: { a: 1 } });

		assert.strictEqual(session?.resource.toString(), 'agent-host-session://worker-1');
		assert.strictEqual(sessions.created.length, 1);
		assert.strictEqual(sessions.created[0].folder!.toString(), folder.toString());
		assert.strictEqual(sessions.created[0].query, 'hello');
		assert.strictEqual(sessions.created[0].metadata!.a, 1);
		assert.strictEqual(sessions.created[0].permissionLevel, undefined, 'no top-level permissionLevel (a normal New Session never sets one)');
		assert.strictEqual(sessions.created[0].autopilotConfig, 'autopilot', 'autopilot is seeded via automationConfiguration for the agent host');
		assert.strictEqual(sessions.created[0].providerId, 'local-agent-host', 'starts on the folder\'s preferred provider, like a normal New Session');
		assert.strictEqual(sessions.created[0].sessionTypeId, 'copilotcli', 'starts on the folder\'s preferred session type');
		assert.deepStrictEqual(chatSessions.retained, ['agent-host-session://worker-1'], 'retains the live session so its finished turn is parseable');
	});

	test('tracks launched sessions as inbox-managed so conversation triage can skip them', async () => {
		const sessions = new FakeSessions();
		const folder = URI.file('/repo');
		sessions.servable.add(folder.toString());
		sessions.createResult = fakeSession('agent-host-session://distiller-1');
		const { launcher } = make(sessions, folder, []);

		assert.strictEqual(launcher.isManaged('agent-host-session://distiller-1'), false, 'unknown before launch');
		await launcher.launch('run', { title: 'Diffy distiller', activity: 'distiller' });

		assert.strictEqual(launcher.isManaged('agent-host-session://distiller-1'), true, 'the launched session is inbox-managed');
		assert.strictEqual(launcher.isManaged('agent-host-session://a-user-chat'), false, 'a session we did not create is not managed');
	});

	test('falls back to the most-recent workspace that can host a session (composer default)', async () => {
		const sessions = new FakeSessions();
		const stale = URI.file('/stale');
		const recent = URI.file('/recent');
		// The window has no folder; the first recent is unservable, the second is.
		sessions.servable.add(recent.toString());
		sessions.createResult = fakeSession('agent-host-session://worker-2');
		const { launcher } = make(sessions, undefined, [stale, recent]);

		assert.strictEqual(launcher.canLaunch(), true);
		const session = await launcher.launch('hi', { title: 'T', activity: 'worker' });

		assert.strictEqual(session?.resource.toString(), 'agent-host-session://worker-2');
		assert.strictEqual(sessions.created[0].folder!.toString(), recent.toString(), 'skips the unservable recent, uses the servable one');
	});

	test('falls back to a workspace-less quick chat (composer default) when no folder is servable', async () => {
		const sessions = new FakeSessions();
		sessions.quickChatAvailable = true; // no servable folder, but a quick-chat target exists
		sessions.createResult = fakeSession('agent-host-session://quick-1');
		const { launcher } = make(sessions, undefined, []);

		assert.strictEqual(launcher.canLaunch(), true);
		const session = await launcher.launch('hi', { title: 'T', activity: 'worker', metadata: { a: 2 } });

		assert.strictEqual(session?.resource.toString(), 'agent-host-session://quick-1');
		assert.strictEqual(sessions.created.length, 1);
		assert.strictEqual(sessions.created[0].folder, undefined, 'workspace-less');
		assert.strictEqual(sessions.created[0].metadata!.a, 2);
	});

	test('returns undefined (no launch) when neither a folder nor a quick chat can host a session', async () => {
		const sessions = new FakeSessions();
		const { launcher } = make(sessions, URI.file('/repo'), [URI.file('/recent')]); // nothing servable, no quick chat

		assert.strictEqual(launcher.canLaunch(), false);
		const session = await launcher.launch('hi', { title: 'T', activity: 'worker' });

		assert.strictEqual(session, undefined);
		assert.strictEqual(sessions.created.length, 0, 'no session is attempted without a servable target');
	});

	test('relay sends into an existing session and reports success/failure', async () => {
		const sessions = new FakeSessions();
		const ref = 'agent-host-session://worker-1';
		sessions.sessionsByRef.set(ref, fakeSession(ref));
		const { launcher } = make(sessions, undefined, []);

		assert.strictEqual(await launcher.relay(ref, 'steer message'), true);
		assert.deepStrictEqual(sessions.relayed, [{ ref, query: 'steer message' }]);

		assert.strictEqual(await launcher.relay('agent-host-session://missing', 'x'), false, 'missing session -> false');
		assert.strictEqual(await launcher.relay('inboxone-pending://worker/x', 'x'), false, 'pending ref -> false');
	});
});
