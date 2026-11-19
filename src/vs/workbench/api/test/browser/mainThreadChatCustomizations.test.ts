/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CustomizationEnablementKind, McpServerStatus } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { CustomizationMarketplaceConfiguration } from '../../../../platform/customizationMarketplace/common/customizationMarketplaceSources.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IAgentHostCustomizationService } from '../../../contrib/chat/browser/agentSessions/agentHost/agentHostCustomizationService.js';
import { ICopilotConnector, ICopilotConnectorsService } from '../../../contrib/chat/browser/aiCustomization/copilotConnectorsService.js';
import { ContributionEnablementState } from '../../../contrib/chat/common/enablement.js';
import { LocalChatSessionUri } from '../../../contrib/chat/common/model/chatUri.js';
import { IMcpServer, IMcpServerStartOpts, IMcpService, McpConnectionState } from '../../../contrib/mcp/common/mcpTypes.js';
import { IAgentHostMcpServer } from '../../../contrib/sessions/common/agentHostSessionsProvider.js';
import { MainThreadChatCustomizations } from '../../browser/mainThreadChatCustomizations.js';
import { ExtHostChatCustomizationsShape } from '../../common/extHost.protocol.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';

suite('MainThreadChatCustomizations', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const agentHostSession = URI.from({ scheme: 'agent-host-copilotcli', path: '/session' });
	const localSession = LocalChatSessionUri.forSession('local');
	const contributedSession = URI.from({ scheme: 'copilot-cloud-agent', path: '/session' });

	let connectors: ICopilotConnector[];
	let agentHostServers: IAgentHostMcpServer[];
	let calls: string[];
	let changes: number;
	let onDidChangeConnectors: Emitter<void>;
	let onDidChangeAgentHost: Emitter<void>;
	let localServers: ISettableObservable<readonly IMcpServer[]>;
	let mainThread: MainThreadChatCustomizations;

	function connector(name: string, connectionStatus: ICopilotConnector['connectionStatus']): ICopilotConnector {
		return upcastPartial<ICopilotConnector>({ name, displayName: name, description: '', keywords: [], connectionStatus });
	}

	function agentHostServer(name: string, status: McpServerStatus, options: Partial<IAgentHostMcpServer> = {}): IAgentHostMcpServer {
		return upcastPartial<IAgentHostMcpServer>({ id: `host/${name}`, name, enabled: true, status, ...options });
	}

	function localServer(label: string, state: McpConnectionState, enabled: boolean): IMcpServer {
		return upcastPartial<IMcpServer>({
			definition: { id: `local.${label}`, label },
			enablement: observableValue('enablement', enabled ? ContributionEnablementState.EnabledProfile : ContributionEnablementState.DisabledProfile),
			connectionState: observableValue('state', state),
			start: async (opts?: IMcpServerStartOpts) => {
				calls.push(`start ${label} ${opts?.promptType}`);
				return { state: McpConnectionState.Kind.Running };
			},
		});
	}

	setup(() => {
		connectors = [];
		agentHostServers = [];
		calls = [];
		changes = 0;
		onDidChangeConnectors = store.add(new Emitter<void>());
		onDidChangeAgentHost = store.add(new Emitter<void>());
		localServers = observableValue<readonly IMcpServer[]>('servers', []);

		const connectorsService = upcastPartial<ICopilotConnectorsService>({
			onDidChange: onDidChangeConnectors.event,
			onDidChangeAccount: Event.None,
			get connectors() { return connectors; },
			connectionStateKnown: true,
			authorizationRequired: false,
			connect: async name => {
				calls.push(`connect ${name}`);
				connectors = connectors.map(candidate => candidate.name === name ? { ...candidate, connectionStatus: 'connected' } : candidate);
			},
		});
		const agentHostCustomizationService = upcastPartial<IAgentHostCustomizationService>({
			onDidChangeCustomizations: onDidChangeAgentHost.event,
			whenCustomizationsReady: async () => true,
			getMcpServers: session => session.toString() === agentHostSession.toString() ? agentHostServers : [],
			setCustomizationEnablement: (_session, id, _current, kind, enabled) => {
				calls.push(`enable ${id} ${kind} ${enabled}`);
				agentHostServers = agentHostServers.map(server => server.id === id ? { ...server, enabled } : server);
				onDidChangeAgentHost.fire();
			},
			authenticateMcpServer: async (_session, id) => {
				calls.push(`authenticate ${id}`);
				return true;
			},
		});
		const mcpService = upcastPartial<IMcpService>({ servers: localServers });
		const productService = upcastPartial<IProductService>({
			defaultChatAgent: upcastPartial<NonNullable<IProductService['defaultChatAgent']>>({ mcpConnectorsUrl: 'https://example.com/connectors' }),
			connectorRecommendations: { slack: { name: 'Slack', description: 'Search Slack.', iconUrl: '', urls: ['slack.com'] } },
		});
		const defaultAccountService = upcastPartial<IDefaultAccountService>({ getDefaultAccountAuthenticationProvider: () => ({ id: 'github', name: 'GitHub', enterprise: false }) });
		const configurationService = new TestConfigurationService({ [CustomizationMarketplaceConfiguration.CopilotConnectorsEnabled]: true });
		const proxy: Partial<ExtHostChatCustomizationsShape> = { $onDidChangeChatCustomizations: () => changes++ };

		mainThread = store.add(new MainThreadChatCustomizations(SingleProxyRPCProtocol(proxy), connectorsService, agentHostCustomizationService, mcpService, productService, configurationService, defaultAccountService, new NullLogService()));
	});

	test('lists the MCP servers of the session it is asked about', async () => {
		connectors = [connector('linear', 'connected')];
		agentHostServers = [agentHostServer('linear-mcp', McpServerStatus.Ready, { connectorName: 'linear', enabled: false }), agentHostServer('host-tool', McpServerStatus.AuthRequired)];
		localServers.set([localServer('local-tool', { state: McpConnectionState.Kind.Stopped }, true)], undefined);

		const summarize = async (session: URI | undefined) => (await mainThread.$getChatCustomizations(session)).map(item => `${item.id}=${item.state}`);
		assert.deepStrictEqual({
			agentHost: await summarize(agentHostSession),
			local: await summarize(localSession),
			contributed: await summarize(contributedSession),
			none: await summarize(undefined),
		}, {
			agentHost: ['mcp:host-tool=needsSignIn', 'linear=off', 'slack=notInstalled'],
			local: ['linear=ready', 'mcp:local-tool=ready', 'slack=notInstalled'],
			contributed: ['linear=ready', 'slack=notInstalled'],
			none: ['linear=ready', 'mcp:local-tool=ready', 'slack=notInstalled'],
		});
	});

	test('takes the one step each state offers', async () => {
		connectors = [connector('linear', 'not_connected')];
		agentHostServers = [agentHostServer('off-tool', McpServerStatus.Ready, { enabled: false, enablement: [{ kind: CustomizationEnablementKind.Global, enabled: false }] }), agentHostServer('auth-tool', McpServerStatus.AuthRequired)];
		localServers.set([localServer('broken', { state: McpConnectionState.Kind.Error, message: 'failed' }, true)], undefined);

		assert.deepStrictEqual([
			await mainThread.$fixChatCustomization(agentHostSession, 'linear'),
			await mainThread.$fixChatCustomization(agentHostSession, 'mcp:off-tool'),
			await mainThread.$fixChatCustomization(agentHostSession, 'mcp:auth-tool'),
			await mainThread.$fixChatCustomization(localSession, 'mcp:broken'),
			await mainThread.$fixChatCustomization(agentHostSession, 'slack'),
			await mainThread.$fixChatCustomization(agentHostSession, 'missing'),
		], ['ready', 'ready', 'needsSignIn', 'error', 'notInstalled', 'unknown']);
		assert.deepStrictEqual(calls, [
			'connect linear',
			`enable host/off-tool ${CustomizationEnablementKind.Session} true`,
			'authenticate host/auth-tool',
			'start broken all-untrusted',
		]);
	});

	test('forwards changes only once listening, coalescing bursts', () => {
		const clock = sinon.useFakeTimers();
		try {
			onDidChangeConnectors.fire();
			clock.tick(200);
			assert.strictEqual(changes, 0);

			mainThread.$startListening();
			mainThread.$startListening();
			onDidChangeConnectors.fire();
			onDidChangeAgentHost.fire();
			localServers.set([localServer('new', { state: McpConnectionState.Kind.Stopped }, true)], undefined);
			clock.tick(200);
			assert.strictEqual(changes, 1);
		} finally {
			clock.restore();
		}
	});
});
