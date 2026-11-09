/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// A webview panel that lives beside the active chat session: stacked with the Chat view in
	// editor windows, and a side-pane tab with a Session Activity Bar entry in the Agents
	// Window. Contributed with `contributes.chatSessionPanels: [{ id, title, icon }]`.

	export interface ChatSessionPanel {
		readonly webviewView: WebviewView;
		/** The session the panel shows: the one the user focused last in this window. */
		readonly session: Uri | undefined;
		readonly onDidChangeSession: Event<Uri | undefined>;
	}

	export interface ChatSessionPanelProvider {
		/** Called when the panel is first shown. */
		resolveChatSessionPanel(panel: ChatSessionPanel, token: CancellationToken): void | Thenable<void>;
	}

	export namespace window {
		export function registerChatSessionPanelProvider(id: string, provider: ChatSessionPanelProvider, options?: { readonly webviewOptions?: { readonly retainContextWhenHidden?: boolean } }): Disposable;
	}
}
