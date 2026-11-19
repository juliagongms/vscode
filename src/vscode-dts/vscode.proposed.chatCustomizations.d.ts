/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	/**
	 * Where a customization stands for a chat session.
	 *
	 * - `notInstalled`: recommended, but there is nothing to connect or turn on yet.
	 * - `notConnected`: a connector the account hasn't connected.
	 * - `pending`: connecting or starting now.
	 * - `off`: available, but turned off for this session.
	 * - `needsSignIn`: connected or configured, but waiting for the user to sign in again.
	 * - `ready`: the session can use it.
	 * - `error`: it fails for a reason one click doesn't fix.
	 * - `unknown`: the editor can't tell, for example before the user has signed in to the catalog.
	 */
	export type ChatCustomizationState = 'notInstalled' | 'notConnected' | 'pending' | 'off' | 'needsSignIn' | 'ready' | 'error' | 'unknown';

	/**
	 * A customization a chat session could use: a Copilot connector or an MCP server.
	 */
	export interface ChatCustomizationInfo {
		/**
		 * Stable identifier: a connector's catalog name, or `mcp:` followed by an MCP server's name.
		 */
		readonly id: string;
		/**
		 * Display name, e.g. `Slack`.
		 */
		readonly name: string;
		/**
		 * What it gives the agent access to, in one sentence.
		 */
		readonly description: string;
		// eslint-disable-next-line local/vscode-dts-string-type-literals, local/vscode-dts-literal-or-types
		readonly kind: 'connector' | 'mcpServer';
		/**
		 * The catalog's keywords. These are categories (`code`, `builds`), not names.
		 */
		readonly keywords: readonly string[];
		/**
		 * Other names people use for it, e.g. `Jira` and `Confluence` for Atlassian Rovo.
		 */
		readonly aliases: readonly string[];
		/**
		 * Domains its links live on, e.g. `slack.com`.
		 */
		readonly domains: readonly string[];
		/**
		 * Its state for the session asked about.
		 */
		readonly state: ChatCustomizationState;
	}

	export namespace chat {
		/**
		 * The customizations a chat session could use, each with its state for that session.
		 * Without a session, the state outside any one session.
		 */
		export function getChatCustomizations(sessionResource?: Uri): Thenable<readonly ChatCustomizationInfo[]>;

		/**
		 * Fires when a customization is added, removed or changes state.
		 */
		export const onDidChangeChatCustomizations: Event<void>;

		/**
		 * Does the one step that makes a customization ready for a session: connects a connector (opening its
		 * consent page), signs a server in again, or turns it on for the session. Call it only from a user's click.
		 * Resolves to the state after the step, or the current state when there is no such step.
		 */
		export function fixChatCustomization(sessionResource: Uri, id: string): Thenable<ChatCustomizationState>;
	}
}
