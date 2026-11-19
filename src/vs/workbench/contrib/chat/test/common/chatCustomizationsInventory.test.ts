/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { McpServerStatus } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { McpConnectionState } from '../../../mcp/common/mcpTypes.js';
import { ChatCustomizationState, computeChatCustomizations, getConnectorState, getMcpServerState, IChatCustomizationConnector, IChatCustomizationInfo, IChatCustomizationMcpServer, IChatCustomizationsInventoryInput, mergeChatCustomizations, toAgentHostMcpServerStatus, toLocalMcpServerStatus } from '../../common/chatCustomizationsInventory.js';

function connector(name: string, connectionStatus: IChatCustomizationConnector['connectionStatus'], options: Partial<IChatCustomizationConnector> = {}): IChatCustomizationConnector {
	return { name, displayName: name, description: `${name} connector`, keywords: [], connectionStatus, ...options };
}

function server(name: string, status: IChatCustomizationMcpServer['status'], options: Partial<IChatCustomizationMcpServer> = {}): IChatCustomizationMcpServer {
	return { name, enabled: true, status, ...options };
}

function compute(input: Partial<IChatCustomizationsInventoryInput>): IChatCustomizationInfo[] {
	return computeChatCustomizations({ connectors: [], catalogKnown: true, authorizationRequired: false, hints: undefined, servers: [], ...input });
}

function states(items: readonly IChatCustomizationInfo[]): Record<string, ChatCustomizationState> {
	return Object.fromEntries(items.map(item => [item.id, item.state]));
}

suite('Chat customizations inventory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps each connector status and detail', () => {
		const cases: [IChatCustomizationConnector['connectionStatus'], string | undefined, boolean, ChatCustomizationState][] = [
			['not_connected', undefined, false, 'notConnected'],
			['pending', undefined, false, 'pending'],
			['connected', undefined, false, 'ready'],
			['error', 'sign_in_required', false, 'needsSignIn'],
			['error', 'reconnect_required', false, 'needsSignIn'],
			['error', 'review_required', false, 'needsSignIn'],
			['error', 'retryable_error', false, 'error'],
			['error', 'unavailable', false, 'error'],
			['error', undefined, false, 'error'],
			['unknown', undefined, true, 'notConnected'],
			['unknown', undefined, false, 'unknown'],
		];
		assert.deepStrictEqual(
			cases.map(([connectionStatus, connectionStatusDetail, authorizationRequired]) => getConnectorState({ connectionStatus, connectionStatusDetail }, authorizationRequired)),
			cases.map(([, , , expected]) => expected),
		);
	});

	test('refines a connector with its server in the session', () => {
		const items = compute({
			connectors: [
				connector('slack', 'connected'),
				connector('linear', 'connected'),
				connector('notion', 'connected'),
				connector('figma', 'not_connected'),
				connector('sentry', 'connected'),
				connector('vercel', 'error', { connectionStatusDetail: 'reconnect_required' }),
				connector('grafana', 'connected'),
			],
			servers: [
				server('slack-mcp', 'ready', { connectorName: 'slack', enabled: false }),
				server('linear-mcp', 'authRequired', { connectorName: 'linear' }),
				server('notion-mcp', 'authenticating', { connectorName: 'notion' }),
				server('figma-mcp', 'ready', { connectorName: 'figma' }),
				server('sentry-mcp', 'error', { connectorName: 'sentry' }),
				server('vercel-mcp', 'error', { connectorName: 'vercel' }),
				server('grafana-mcp', 'stopped', { connectorName: 'grafana' }),
			],
		});
		assert.deepStrictEqual(states(items), { figma: 'ready', grafana: 'ready', linear: 'needsSignIn', notion: 'pending', sentry: 'error', slack: 'off', vercel: 'needsSignIn' });
		assert.ok(items.every(item => item.kind === 'connector'), 'servers a connector owns are not listed on their own');
	});

	test('merges a hint into its connector', () => {
		const [item] = compute({
			connectors: [connector('rovo', 'not_connected', { displayName: 'Atlassian Rovo', keywords: ['jira'], homepage: URI.parse('https://www.atlassian.com:443/rovo') })],
			hints: { rovo: { name: 'Rovo', description: 'Hint description', aliases: ['Jira', 'Confluence'], urls: ['atlassian.net', 'atlassian.com'] } },
		});
		assert.deepStrictEqual(item, {
			id: 'rovo',
			name: 'Atlassian Rovo',
			description: 'rovo connector',
			kind: 'connector',
			keywords: ['jira'],
			aliases: ['Jira', 'Confluence'],
			domains: ['atlassian.com', 'atlassian.net'],
			state: 'notConnected',
		});
	});

	test('lists a hint without a connector by what the catalog knows', () => {
		const hints = { slack: { name: 'Slack', description: 'Search Slack.', urls: ['slack.com'] } };
		const expected = (state: ChatCustomizationState): IChatCustomizationInfo[] => [{ id: 'slack', name: 'Slack', description: 'Search Slack.', kind: 'connector', keywords: [], aliases: [], domains: ['slack.com'], state }];

		assert.deepStrictEqual(compute({ hints, catalogKnown: true }), expected('notInstalled'));
		assert.deepStrictEqual(compute({ hints, catalogKnown: false }), expected('notConnected'));
		assert.deepStrictEqual(compute({ hints, catalogKnown: false, servers: [server('slack-mcp', 'ready', { connectorName: 'slack' })] }), expected('ready'));
		assert.deepStrictEqual(compute({ hints, connectors: undefined }), [], 'no hints while connectors are turned off');
	});

	test('maps MCP server states', () => {
		const cases: [IChatCustomizationMcpServer, ChatCustomizationState][] = [
			[server('a', 'ready', { enabled: false }), 'off'],
			[server('a', 'authRequired', { enabled: false }), 'off'],
			[server('a', 'authRequired'), 'needsSignIn'],
			[server('a', 'authenticating'), 'pending'],
			[server('a', 'starting'), 'pending'],
			[server('a', 'error'), 'error'],
			[server('a', 'ready'), 'ready'],
			[server('a', 'stopped'), 'ready'],
		];
		assert.deepStrictEqual(cases.map(([input]) => getMcpServerState(input)), cases.map(([, expected]) => expected));

		assert.deepStrictEqual([
			toAgentHostMcpServerStatus(McpServerStatus.AuthRequired, true),
			toAgentHostMcpServerStatus(McpServerStatus.AuthRequired, false),
			toAgentHostMcpServerStatus(McpServerStatus.Stopped, undefined),
			toLocalMcpServerStatus({ state: McpConnectionState.Kind.Stopped, reason: 'needs-user-interaction' }),
			toLocalMcpServerStatus({ state: McpConnectionState.Kind.Stopped }),
			toLocalMcpServerStatus({ state: McpConnectionState.Kind.Error, message: 'failed' }),
		], ['authenticating', 'authRequired', 'stopped', 'authRequired', 'stopped', 'error']);

		assert.deepStrictEqual(compute({ servers: [server('github', 'ready', { displayName: 'GitHub' }), server('orphan', 'ready', { connectorName: 'missing' })] }), [
			{ id: 'mcp:github', name: 'GitHub', description: '', kind: 'mcpServer', keywords: [], aliases: ['github'], domains: [], state: 'ready' },
			{ id: 'mcp:orphan', name: 'orphan', description: '', kind: 'mcpServer', keywords: [], aliases: [], domains: [], state: 'ready' },
		]);
	});

	test('dedupes by id with connectors first and sorts by name', () => {
		const item = (id: string, name: string, kind: IChatCustomizationInfo['kind'], state: ChatCustomizationState): IChatCustomizationInfo => ({ id, name, description: '', kind, keywords: [], aliases: [], domains: [], state });
		assert.deepStrictEqual(
			mergeChatCustomizations(
				[item('slack', 'Slack', 'connector', 'ready'), item('linear', 'linear', 'connector', 'ready'), item('slack', 'Slack', 'connector', 'error')],
				[item('mcp:b', 'Beta', 'mcpServer', 'ready'), item('mcp:b', 'Beta', 'mcpServer', 'off')],
			),
			[item('mcp:b', 'Beta', 'mcpServer', 'ready'), item('linear', 'linear', 'connector', 'ready'), item('slack', 'Slack', 'connector', 'ready')],
		);
	});
});
