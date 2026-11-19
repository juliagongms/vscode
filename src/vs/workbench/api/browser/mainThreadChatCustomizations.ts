/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout, raceTimeout, RunOnceScheduler } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { autorun } from '../../../base/common/observable.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { isCustomizationEnabled } from '../../../platform/agentHost/common/customizationEnablement.js';
import { CustomizationEnablementKind } from '../../../platform/agentHost/common/state/protocol/state.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { CustomizationMarketplaceConfiguration } from '../../../platform/customizationMarketplace/common/customizationMarketplaceSources.js';
import { IDefaultAccountService } from '../../../platform/defaultAccount/common/defaultAccount.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IAgentHostCustomizationService } from '../../contrib/chat/browser/agentSessions/agentHost/agentHostCustomizationService.js';
import { ICopilotConnectorsService } from '../../contrib/chat/browser/aiCustomization/copilotConnectorsService.js';
import { ChatCustomizationState, computeChatCustomizations, IChatCustomizationInfo, IChatCustomizationMcpServer, MCP_SERVER_CUSTOMIZATION_ID_PREFIX, toAgentHostMcpServerStatus, toLocalMcpServerStatus } from '../../contrib/chat/common/chatCustomizationsInventory.js';
import { isAgentHostSessionResource, localChatSessionType } from '../../contrib/chat/common/chatSessionsService.js';
import { ContributionEnablementState, isContributionEnabled } from '../../contrib/chat/common/enablement.js';
import { getChatSessionType } from '../../contrib/chat/common/model/chatUri.js';
import { IMcpServer, IMcpService } from '../../contrib/mcp/common/mcpTypes.js';
import { IAgentHostMcpServer } from '../../contrib/sessions/common/agentHostSessionsProvider.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostChatCustomizationsShape, ExtHostContext, MainContext, MainThreadChatCustomizationsShape } from '../common/extHost.protocol.js';

/** Coalesces bursts of changes into one event. */
const CHANGE_DELAY = 100;
/** How long a listing waits for the connector catalog to load. */
const CATALOG_TIMEOUT = 15_000;
/** How long a listing waits for an agent-host session's first state. */
const SESSION_READY_TIMEOUT = 2_000;
/** How long a fix waits for the user, e.g. on a consent page or a sign-in prompt. */
const FIX_TIMEOUT = 5 * 60_000;
/** How long a fix waits for an agent host to report a change it made. */
const SETTLE_TIMEOUT = 2_000;

/** A session's MCP server, as the inventory sees it and as it was found. */
interface ISessionMcpServer {
	readonly server: IChatCustomizationMcpServer;
	readonly agentHost?: IAgentHostMcpServer;
	readonly local?: IMcpServer;
}

interface IChatCustomizationsSnapshot {
	readonly items: readonly IChatCustomizationInfo[];
	readonly servers: readonly ISessionMcpServer[];
}

/**
 * Proposed API `chatCustomizations`: the Copilot connectors, product hints and MCP servers a chat session could
 * use, each with its state for the session, and the one step that makes a customization ready.
 */
@extHostNamedCustomer(MainContext.MainThreadChatCustomizations)
export class MainThreadChatCustomizations extends Disposable implements MainThreadChatCustomizationsShape {

	private readonly _proxy: ExtHostChatCustomizationsShape;
	private readonly _listening = this._register(new MutableDisposable<DisposableStore>());
	/** Work in flight, cancelled when the extension host goes away. */
	private readonly _pending = this._register(new DisposableStore());
	private _catalogLoad: Promise<void> | undefined;

	constructor(
		extHostContext: IExtHostContext,
		@ICopilotConnectorsService private readonly _connectorsService: ICopilotConnectorsService,
		@IAgentHostCustomizationService private readonly _agentHostCustomizationService: IAgentHostCustomizationService,
		@IMcpService private readonly _mcpService: IMcpService,
		@IProductService private readonly _productService: IProductService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDefaultAccountService private readonly _defaultAccountService: IDefaultAccountService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostChatCustomizations);
	}

	async $getChatCustomizations(session: UriComponents | undefined): Promise<IChatCustomizationInfo[]> {
		return [...(await this._snapshot(session ? URI.revive(session) : undefined)).items];
	}

	async $fixChatCustomization(sessionComponents: UriComponents, id: string): Promise<ChatCustomizationState> {
		const session = URI.revive(sessionComponents);
		const before = await this._snapshot(session);
		const item = before.items.find(candidate => candidate.id === id);
		if (!item) {
			return 'unknown';
		}
		try {
			if (!await this._fix(session, item, before.servers)) {
				return item.state;
			}
		} catch (error) {
			if (!isCancellationError(error)) {
				this._logService.warn(`[MainThreadChatCustomizations] Could not fix '${id}'`, error);
			}
		}
		const after = await this._snapshot(session);
		return after.items.find(candidate => candidate.id === id)?.state ?? 'unknown';
	}

	$startListening(): void {
		if (this._listening.value) {
			return;
		}
		const store = new DisposableStore();
		const scheduler = store.add(new RunOnceScheduler(() => this._proxy.$onDidChangeChatCustomizations(), CHANGE_DELAY));
		const onChange = () => {
			if (!scheduler.isScheduled()) {
				scheduler.schedule();
			}
		};
		store.add(this._connectorsService.onDidChange(onChange));
		store.add(this._connectorsService.onDidChangeAccount(onChange));
		store.add(this._agentHostCustomizationService.onDidChangeCustomizations(onChange));
		store.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CustomizationMarketplaceConfiguration.CopilotConnectorsEnabled)) {
				onChange();
			}
		}));
		let initialRun = true;
		store.add(autorun(reader => {
			for (const server of this._mcpService.servers.read(reader)) {
				server.connectionState.read(reader);
				server.enablement.read(reader);
			}
			if (initialRun) {
				initialRun = false;
			} else {
				onChange();
			}
		}));
		this._listening.value = store;
	}

	private async _snapshot(session: URI | undefined): Promise<IChatCustomizationsSnapshot> {
		const connectorsAvailable = this._connectorsAvailable();
		const [servers] = await Promise.all([
			this._getSessionServers(session),
			connectorsAvailable && !this._connectorsService.connectionStateKnown ? this._loadCatalog() : undefined,
		]);
		const items = computeChatCustomizations({
			connectors: connectorsAvailable ? this._connectorsService.connectors : undefined,
			catalogKnown: this._connectorsService.connectionStateKnown,
			authorizationRequired: this._connectorsService.authorizationRequired,
			hints: this._productService.connectorRecommendations,
			servers: servers.map(entry => entry.server),
		});
		return { items, servers };
	}

	/**
	 * Whether Copilot connectors can be connected here: they are turned on, the product has their endpoint, and the
	 * account is not a GitHub Enterprise one, which connectors don't support. Otherwise no connector is listed,
	 * since none could be connected.
	 */
	private _connectorsAvailable(): boolean {
		return this._configurationService.getValue<boolean>(CustomizationMarketplaceConfiguration.CopilotConnectorsEnabled) === true
			&& !!this._productService.defaultChatAgent?.mcpConnectorsUrl
			&& !this._defaultAccountService.getDefaultAccountAuthenticationProvider().enterprise;
	}

	/** Loads the connector catalog once for concurrent listings; on failure the listing uses what is known. */
	private _loadCatalog(): Promise<void> {
		this._catalogLoad ??= this._withCancellation(CATALOG_TIMEOUT, token => this._connectorsService.getConnectors(token))
			.then(() => undefined, error => {
				if (!isCancellationError(error)) {
					this._logService.trace('[MainThreadChatCustomizations] Could not load the connector catalog', error);
				}
			})
			.finally(() => {
				this._catalogLoad = undefined;
			});
		return this._catalogLoad;
	}

	/**
	 * The MCP servers a session uses: an agent-host session's own servers, or the window's servers for a local
	 * chat session and outside any session. Other session types run servers VS Code doesn't see.
	 */
	private async _getSessionServers(session: URI | undefined): Promise<ISessionMcpServer[]> {
		if (session && isAgentHostSessionResource(session)) {
			try {
				await this._withCancellation(SESSION_READY_TIMEOUT, token => this._agentHostCustomizationService.whenCustomizationsReady(session, token));
			} catch (error) {
				if (!isCancellationError(error)) {
					this._logService.trace('[MainThreadChatCustomizations] Agent host session state is unavailable', error);
				}
			}
			return this._agentHostCustomizationService.getMcpServers(session).map(server => ({
				server: {
					name: server.name,
					displayName: server.displayName,
					connectorName: server.connectorName,
					enabled: server.enabled,
					status: toAgentHostMcpServerStatus(server.status, server.authenticating),
				},
				agentHost: server,
			}));
		}
		if (session && getChatSessionType(session) !== localChatSessionType) {
			return [];
		}
		return this._mcpService.servers.get().map(server => ({
			server: {
				name: server.definition.label,
				enabled: isContributionEnabled(server.enablement.get()),
				status: toLocalMcpServerStatus(server.connectionState.get()),
			},
			local: server,
		}));
	}

	/** Takes the one step that makes the customization ready, and returns whether there was one. */
	private async _fix(session: URI, item: IChatCustomizationInfo, servers: readonly ISessionMcpServer[]): Promise<boolean> {
		const sessionServer = item.kind === 'connector'
			? servers.find(entry => entry.server.connectorName === item.id)
			: servers.find(entry => MCP_SERVER_CUSTOMIZATION_ID_PREFIX + entry.server.name === item.id);
		switch (item.state) {
			case 'off':
				return sessionServer ? this._turnOn(session, sessionServer) : false;
			case 'needsSignIn':
				if (sessionServer?.agentHost && sessionServer.server.status === 'authRequired') {
					// Signs a connector's server in through Copilot connectors, any other with its own authentication.
					await raceTimeout(this._agentHostCustomizationService.authenticateMcpServer(session, sessionServer.agentHost.id), FIX_TIMEOUT);
					return true;
				}
				if (sessionServer?.local) {
					await this._startLocalServer(sessionServer.local);
					return true;
				}
				return item.kind === 'connector' ? this._connect(item.id) : false;
			case 'notConnected':
			case 'unknown':
				return item.kind === 'connector' ? this._connect(item.id) : false;
			case 'error':
				if (sessionServer?.local) {
					await this._startLocalServer(sessionServer.local);
					return true;
				}
				return false;
			default:
				return false;
		}
	}

	/**
	 * Connects a connector, opening its consent page. Connecting refreshes live agent-host sessions, so a
	 * session picks up the connector's servers.
	 */
	private async _connect(name: string): Promise<boolean> {
		await this._withCancellation(FIX_TIMEOUT, token => this._connectorsService.connect(name, token));
		return true;
	}

	/** Turns a server on for the session, as the Chat Customizations editor does. */
	private async _turnOn(session: URI, { agentHost, local }: ISessionMcpServer): Promise<boolean> {
		if (agentHost) {
			const reason = agentHost.disabledReason;
			if (reason?.source === 'plugin') {
				this._agentHostCustomizationService.setCustomizationEnablement(session, reason.plugin.id, reason.plugin.enablement, CustomizationEnablementKind.Session, true);
			}
			if (!isCustomizationEnabled(agentHost)) {
				this._agentHostCustomizationService.setCustomizationEnablement(session, agentHost.id, agentHost.enablement, CustomizationEnablementKind.Session, true);
			}
			await this._whenAgentHostServerEnabled(session, agentHost.id);
			return true;
		}
		if (local) {
			// Local servers have no session scope; enable the scope that disabled the server.
			const current = this._mcpService.enablementModel.readEnabled(local.definition.id);
			this._mcpService.enablementModel.setEnabled(local.definition.id, current === ContributionEnablementState.DisabledWorkspace ? ContributionEnablementState.EnabledWorkspace : ContributionEnablementState.EnabledProfile);
			return true;
		}
		return false;
	}

	/** Waits briefly for the agent host to apply a session's enablement change, which it reports asynchronously. */
	private async _whenAgentHostServerEnabled(session: URI, serverId: string): Promise<void> {
		const isEnabled = () => this._agentHostCustomizationService.getMcpServers(session).find(server => server.id === serverId)?.enabled !== false;
		if (isEnabled()) {
			return;
		}
		const store = this._pending.add(new DisposableStore());
		try {
			await raceTimeout(new Promise<void>(resolve => {
				store.add(toDisposable(resolve));
				store.add(this._agentHostCustomizationService.onDidChangeCustomizations(() => {
					if (isEnabled()) {
						resolve();
					}
				}));
			}), SETTLE_TIMEOUT);
		} finally {
			this._pending.delete(store);
		}
	}

	/** Starts a local server as the MCP views do, prompting for trust or sign-in as needed. */
	private async _startLocalServer(server: IMcpServer): Promise<void> {
		await raceTimeout(server.start({ promptType: 'all-untrusted' }), FIX_TIMEOUT);
	}

	private async _withCancellation<T>(timeout: number, task: (token: CancellationToken) => Promise<T>): Promise<T> {
		const store = this._pending.add(new DisposableStore());
		const cancellation = new CancellationTokenSource();
		store.add(toDisposable(() => cancellation.dispose(true)));
		disposableTimeout(() => cancellation.cancel(), timeout, store);
		try {
			return await task(cancellation.token);
		} finally {
			this._pending.delete(store);
		}
	}
}
