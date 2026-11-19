/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { McpServerStatus } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { McpConnectionState } from '../../mcp/common/mcpTypes.js';

/** Where a customization stands for a chat session. Mirrors `vscode.ChatCustomizationState`. */
export type ChatCustomizationState = 'notInstalled' | 'notConnected' | 'pending' | 'off' | 'needsSignIn' | 'ready' | 'error' | 'unknown';

/** A customization a chat session could use. Mirrors `vscode.ChatCustomizationInfo`. */
export interface IChatCustomizationInfo {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly kind: 'connector' | 'mcpServer';
	readonly keywords: readonly string[];
	readonly aliases: readonly string[];
	readonly domains: readonly string[];
	readonly state: ChatCustomizationState;
}

/** Prefix of an MCP server's customization id, followed by the server's name. */
export const MCP_SERVER_CUSTOMIZATION_ID_PREFIX = 'mcp:';

/** What the inventory reads of a Copilot connector. `ICopilotConnector` satisfies it. */
export interface IChatCustomizationConnector {
	readonly name: string;
	readonly displayName: string;
	readonly description: string;
	readonly keywords: readonly string[];
	readonly homepage?: URI;
	readonly connectionStatus: 'unknown' | 'not_connected' | 'pending' | 'connected' | 'error';
	readonly connectionStatusDetail?: string;
}

/** A product hint: an `IProductConfiguration.connectorRecommendations` entry, keyed by connector name. */
export interface IChatCustomizationHint {
	readonly name: string;
	readonly description: string;
	readonly aliases?: readonly string[];
	readonly urls?: readonly string[];
}

/** Runtime status of a session's MCP server, whether an agent host or the local MCP service runs it. */
export type ChatCustomizationMcpServerStatus = 'ready' | 'stopped' | 'starting' | 'authRequired' | 'authenticating' | 'error';

/** A session's MCP server, reduced to what decides its state. */
export interface IChatCustomizationMcpServer {
	readonly name: string;
	readonly displayName?: string;
	/** The Copilot connector that owns the server, when the agent host reports one. */
	readonly connectorName?: string;
	/** Whether the session may use the server: neither it nor its plugin is turned off. */
	readonly enabled: boolean;
	readonly status: ChatCustomizationMcpServerStatus;
}

export interface IChatCustomizationsInventoryInput {
	/** The connector catalog, or `undefined` while Copilot connectors are turned off or unavailable. */
	readonly connectors: readonly IChatCustomizationConnector[] | undefined;
	/** Whether the catalog has loaded, so that a connector missing from it is not available. */
	readonly catalogKnown: boolean;
	/** Whether connector consent is needed before the catalog can report connections. */
	readonly authorizationRequired: boolean;
	readonly hints: Readonly<Record<string, IChatCustomizationHint>> | undefined;
	/** The session's MCP servers. */
	readonly servers: readonly IChatCustomizationMcpServer[];
}

const signInStatusDetails: ReadonlySet<string> = new Set(['sign_in_required', 'reconnect_required', 'review_required']);

/** The account-wide state of a catalog connector. */
export function getConnectorState(connector: Pick<IChatCustomizationConnector, 'connectionStatus' | 'connectionStatusDetail'>, authorizationRequired: boolean): ChatCustomizationState {
	switch (connector.connectionStatus) {
		case 'not_connected':
			return 'notConnected';
		case 'pending':
			return 'pending';
		case 'connected':
			return 'ready';
		case 'error':
			return connector.connectionStatusDetail !== undefined && signInStatusDetails.has(connector.connectionStatusDetail) ? 'needsSignIn' : 'error';
		case 'unknown':
			// Connecting authorizes first, so a connector hidden behind authorization is one click from connected.
			return authorizationRequired ? 'notConnected' : 'unknown';
	}
}

/**
 * Refines a connector's account-wide state with the server it has in the session, if any: the server may be
 * turned off for the session, wait for sign-in, start, serve the session already, or fail although the account
 * is connected. A stopped server starts on use, so the account-wide state stands.
 */
export function refineConnectorStateForSession(state: ChatCustomizationState, server: IChatCustomizationMcpServer | undefined): ChatCustomizationState {
	if (!server) {
		return state;
	}
	if (!server.enabled) {
		return 'off';
	}
	switch (server.status) {
		case 'authRequired':
			return 'needsSignIn';
		case 'authenticating':
		case 'starting':
			return 'pending';
		case 'ready':
			return 'ready';
		case 'error':
			return state === 'ready' ? 'error' : state;
		case 'stopped':
			return state;
	}
}

/** The state of an MCP server for its session. A server that is stopped starts on use, so it counts as ready. */
export function getMcpServerState(server: Pick<IChatCustomizationMcpServer, 'enabled' | 'status'>): ChatCustomizationState {
	if (!server.enabled) {
		return 'off';
	}
	switch (server.status) {
		case 'authRequired':
			return 'needsSignIn';
		case 'authenticating':
		case 'starting':
			return 'pending';
		case 'error':
			return 'error';
		case 'ready':
		case 'stopped':
			return 'ready';
	}
}

/** The status of an agent host's MCP server. `authenticating` is true while VS Code signs it in silently. */
export function toAgentHostMcpServerStatus(status: McpServerStatus, authenticating: boolean | undefined): ChatCustomizationMcpServerStatus {
	switch (status) {
		case McpServerStatus.Ready:
			return 'ready';
		case McpServerStatus.Starting:
			return 'starting';
		case McpServerStatus.AuthRequired:
			return authenticating ? 'authenticating' : 'authRequired';
		case McpServerStatus.Error:
			return 'error';
		case McpServerStatus.Stopped:
			return 'stopped';
	}
}

/** The status of a local MCP server. One stopped for user interaction waits to be signed in. */
export function toLocalMcpServerStatus(state: McpConnectionState): ChatCustomizationMcpServerStatus {
	switch (state.state) {
		case McpConnectionState.Kind.Running:
			return 'ready';
		case McpConnectionState.Kind.Starting:
			return 'starting';
		case McpConnectionState.Kind.Error:
			return 'error';
		case McpConnectionState.Kind.Stopped:
			return state.reason === 'needs-user-interaction' ? 'authRequired' : 'stopped';
	}
}

/** The domain of a homepage: its hostname without port or a leading `www.`. */
export function getHomepageDomain(homepage: URI | undefined): string | undefined {
	if (!homepage) {
		return undefined;
	}
	let host = homepage.authority.toLowerCase();
	host = host.slice(host.lastIndexOf('@') + 1).replace(/:\d*$/, '').replace(/\.$/, '');
	if (host.startsWith('www.')) {
		host = host.slice(4);
	}
	return host || undefined;
}

/** The customization of an MCP server that no connector owns. */
export function toMcpServerCustomization(server: IChatCustomizationMcpServer): IChatCustomizationInfo {
	const name = server.displayName || server.name;
	return {
		id: MCP_SERVER_CUSTOMIZATION_ID_PREFIX + server.name,
		name,
		description: '',
		kind: 'mcpServer',
		keywords: [],
		aliases: name !== server.name ? [server.name] : [],
		domains: [],
		state: getMcpServerState(server),
	};
}

/**
 * The customizations a session could use: catalog connectors with their product hints, hinted connectors
 * the catalog lacks, and the session's MCP servers that no connector owns.
 */
export function computeChatCustomizations(input: IChatCustomizationsInventoryInput): IChatCustomizationInfo[] {
	const serversByConnector = new Map<string, IChatCustomizationMcpServer>();
	for (const server of input.servers) {
		if (server.connectorName !== undefined && !serversByConnector.has(server.connectorName)) {
			serversByConnector.set(server.connectorName, server);
		}
	}

	const connectors: IChatCustomizationInfo[] = [];
	if (input.connectors) {
		const hints = new Map(Object.entries(input.hints ?? {}));
		for (const connector of input.connectors) {
			const hint = hints.get(connector.name);
			const homepageDomain = getHomepageDomain(connector.homepage);
			connectors.push({
				id: connector.name,
				name: connector.displayName,
				description: connector.description,
				kind: 'connector',
				keywords: connector.keywords,
				aliases: hint?.aliases ?? [],
				domains: distinctStrings([...(homepageDomain ? [homepageDomain] : []), ...(hint?.urls ?? [])]),
				state: refineConnectorStateForSession(getConnectorState(connector, input.authorizationRequired), serversByConnector.get(connector.name)),
			});
		}
		const catalogNames = new Set(input.connectors.map(connector => connector.name));
		for (const [id, hint] of hints) {
			if (catalogNames.has(id)) {
				continue;
			}
			connectors.push({
				id,
				name: hint.name,
				description: hint.description,
				kind: 'connector',
				keywords: [],
				aliases: hint.aliases ?? [],
				domains: distinctStrings(hint.urls ?? []),
				state: refineConnectorStateForSession(input.catalogKnown ? 'notInstalled' : 'notConnected', serversByConnector.get(id)),
			});
		}
	}

	const connectorIds = new Set(connectors.map(connector => connector.id));
	const servers = input.servers
		.filter(server => server.connectorName === undefined || !connectorIds.has(server.connectorName))
		.map(toMcpServerCustomization);
	return mergeChatCustomizations(connectors, servers);
}

/** Merges connectors and MCP servers: the first entry of each id wins, connectors first, sorted by name. */
export function mergeChatCustomizations(connectors: readonly IChatCustomizationInfo[], servers: readonly IChatCustomizationInfo[]): IChatCustomizationInfo[] {
	const byId = new Map<string, IChatCustomizationInfo>();
	for (const item of [...connectors, ...servers]) {
		if (!byId.has(item.id)) {
			byId.set(item.id, item);
		}
	}
	return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function distinctStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}
