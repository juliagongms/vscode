/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ChatPermissionLevel } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ICreateNewSessionOptions, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsRecentWorkspacesService } from '../../../services/sessions/browser/sessionsRecentWorkspacesService.js';

/** Storage key for the durable set of session resources this launcher created. */
const MANAGED_SESSIONS_KEY = 'inboxOne.managedSessions';
/** Cap on retained managed refs (FIFO), enough to cover live + recently-completed inbox sessions. */
const MANAGED_SESSIONS_CAP = 500;


export const IInboxOneSessionLauncher = createDecorator<IInboxOneSessionLauncher>('inboxOneSessionLauncher');

export interface ILaunchOptions {
	/** Session title (shown in the list). */
	readonly title: string;
	/** Provider metadata stamped on the session (e.g. to route its lifecycle events back to an owning task). */
	readonly metadata?: Record<string, unknown>;
	/** Short activity label for diagnostics (e.g. `worker code-review`, `distiller`). */
	readonly activity: string;
}

/**
 * The single seam through which ALL Inbox One agent sessions are created and
 * messaged (worker dispatch, the learning distiller/curator, and any future
 * ambient session). It adds no runtime of its own: it reuses the exact session
 * harness the New Session composer uses ({@link ISessionsManagementService}),
 * targeting the SAME default the composer would -- the sessions window's open
 * folder, else the most-recent workspace that can host a session, else a
 * workspace-less session (the composer's "Start without a backing workspace"
 * default). This keeps every inbox agent call generic -- no per-feature folder
 * resolution, no cloud redirect, no simulation -- so wherever a human could start
 * a New Session, Diffy can start one too.
 */
export interface IInboxOneSessionLauncher {
	readonly _serviceBrand: undefined;

	/**
	 * Whether a session could be started right now (a servable workspace target
	 * exists), mirroring the New Session composer's availability.
	 */
	canLaunch(): boolean;

	/**
	 * Start a background agent session whose first message is {@link firstMessage},
	 * in the default workspace. Returns the committed session, or `undefined` when
	 * no session target is available yet (same as the composer showing an empty
	 * state) or the send failed.
	 */
	launch(firstMessage: string, options: ILaunchOptions): Promise<ISession | undefined>;

	/**
	 * Relay a follow-up message into an existing session (steering / warm reuse),
	 * fire-and-forget in the background. Returns `false` when the session is gone
	 * or the ref is not a real session.
	 */
	relay(sessionRef: string, message: string): Promise<boolean>;

	/**
	 * Whether `sessionRef` names a session this launcher created -- i.e. an
	 * inbox-internal ambient session (a dispatched worker or the learning
	 * distiller), not a session a human started. Conversation triage uses this to
	 * skip Diffy's own machinery so only genuine user chats are surfaced. The set
	 * is persisted, so a window reload still recognizes an inbox session that
	 * finishes after the reload (otherwise an orphaned worker/distiller session
	 * would be mis-surfaced as a finished conversation).
	 */
	isManaged(sessionRef: string): boolean;
}

export class InboxOneSessionLauncher implements IInboxOneSessionLauncher {

	declare readonly _serviceBrand: undefined;

	/** Resources of sessions this launcher created (inbox-internal ambient sessions). Durable so a window reload still recognizes them. */
	private readonly managed: Set<string>;

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ISessionsRecentWorkspacesService private readonly recentWorkspaces: ISessionsRecentWorkspacesService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@IChatSessionsService private readonly chatSessions: IChatSessionsService,
		@ILogService private readonly logService: ILogService,
	) {
		this.managed = new Set(this.loadManaged());
	}

	private loadManaged(): readonly string[] {
		try {
			const raw = this.storageService.get(MANAGED_SESSIONS_KEY, StorageScope.APPLICATION);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
		} catch {
			return [];
		}
	}

	private rememberManaged(sessionRef: string): void {
		if (this.managed.has(sessionRef)) {
			return;
		}
		this.managed.add(sessionRef);
		// FIFO-trim so the durable set stays bounded over the app's lifetime.
		let refs = [...this.managed];
		if (refs.length > MANAGED_SESSIONS_CAP) {
			refs = refs.slice(refs.length - MANAGED_SESSIONS_CAP);
			this.managed.clear();
			for (const r of refs) {
				this.managed.add(r);
			}
		}
		this.storageService.store(MANAGED_SESSIONS_KEY, JSON.stringify(refs), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	canLaunch(): boolean {
		return !!this.resolveDefaultFolder() || this.sessions.isQuickChatTargetAvailable();
	}

	async launch(firstMessage: string, options: ILaunchOptions): Promise<ISession | undefined> {
		const request = { query: firstMessage, title: options.title, background: true };
		// Ambient inbox sessions run fully autonomously (no human at the keyboard),
		// so they must not stall on tool-approval prompts: seed Autopilot mode and
		// Allow all permissions independently through `automationConfiguration`, the
		// same unattended-session primitive Automations use. Passing the legacy
		// combined `permissionLevel: 'autopilot'` would be migrated to Assisted.
		// We
		// deliberately do NOT set the top-level `permissionLevel`: a normal New Session
		// never does, and a provider whose `setPermissionLevel` throws (e.g.
		// `default-copilot`) would otherwise fail the whole launch.
		const createOptions: ICreateNewSessionOptions = {
			automationConfiguration: {
				mode: ChatPermissionLevel.Autopilot,
				permissionLevel: ChatPermissionLevel.AutoApprove,
			},
			...(options.metadata ? { metadata: options.metadata } : {}),
		};
		const folder = this.resolveDefaultFolder();
		try {
			let session: ISession | undefined;
			if (folder) {
				// Start on exactly the provider a human's New Session would use here: the
				// folder's preferred (first) session type. Reusing this composer primitive
				// keeps the inbox on the same runtime as normal chat sessions instead of
				// whatever the service picks as a bare default.
				const preferred = this.sessions.getSessionTypesForFolder(folder)[0];
				const folderOptions = preferred
					? { ...createOptions, providerId: preferred.providerId, sessionTypeId: preferred.sessionType.id }
					: createOptions;
				session = await this.sessions.createAndSendNewChatRequest(folder, request, folderOptions);
			} else if (this.sessions.isQuickChatTargetAvailable()) {
				// No servable workspace folder: use the composer's "Start without a
				// backing workspace" default -- a workspace-less session on whatever
				// target the New Session composer would use here.
				session = await this.sessions.createAndSendQuickChatRequest(request, createOptions);
			} else {
				this.logService.info(`[inboxOne] no session target available to launch ${options.activity} (open a workspace as you would for a New Session)`);
				return undefined;
			}
			if (session) {
				// Keep the same live chat-session object that owns this background
				// turn registered with the standard chat-session harness. When the
				// turn finishes, getChatSessionHistory then reads its completed
				// response (including `inbox-one-result`) instead of resolving a
				// second provider snapshot that can still have history=[].
				await this.chatSessions.getOrCreateChatSession(session.resource, CancellationToken.None);
				this.rememberManaged(session.resource.toString());
				this.logService.info(`[inboxOne] launched ${options.activity} -> ${session.resource.toString()}`);
			}
			return session;
		} catch (err) {
			this.logService.error(`[inboxOne] launch ${options.activity} failed`, err);
			return undefined;
		}
	}

	async relay(sessionRef: string, message: string): Promise<boolean> {
		let uri: URI;
		try {
			uri = URI.parse(sessionRef);
		} catch {
			return false;
		}
		const session = this.sessions.getSession(uri);
		if (!session) {
			return false;
		}
		try {
			await this.sessions.sendRequest(session, session.mainChat.get(), { query: message, background: true });
			return true;
		} catch (err) {
			this.logService.warn(`[inboxOne] relay to ${sessionRef} failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	isManaged(sessionRef: string): boolean {
		return this.managed.has(sessionRef);
	}

	/**
	 * The default workspace a New Session would target: the sessions window's open
	 * folder if there is one, otherwise the most-recent workspace that can host a
	 * session (the same recent-workspaces list the composer's workspace picker
	 * offers). Only servable targets are returned, so a stale/unservable entry is
	 * skipped rather than causing a failed dispatch.
	 */
	private resolveDefaultFolder(): URI | undefined {
		const local = this.workspaceContext.getWorkspace().folders[0]?.uri;
		if (local && this.sessions.isNewSessionTargetAvailable(local)) {
			return local;
		}
		for (const recent of this.recentWorkspaces.getRecentWorkspaces()) {
			const root = recent.workspace.folders[0]?.root;
			if (root && this.sessions.isNewSessionTargetAvailable(root)) {
				return root;
			}
		}
		return undefined;
	}
}
