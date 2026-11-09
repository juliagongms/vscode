/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// A webview panel that lives beside the active chat session: stacked with the Chat view in
	// editor windows, in the side pane next to the focused session in the Agents Window.
	// Contributed with `contributes.chatSessionPanels: [{ id, title, icon }]`.

	export interface ChatSessionPanelProvider {
		/** Called once, when the panel is first shown; `session` is the session it shows. */
		resolveChatSessionPanel(panel: WebviewView, session: Uri | undefined, token: CancellationToken): void | Thenable<void>;
		/** The panel now follows another session (focus moved). */
		onDidChangeChatSessionPanelSession?(panel: WebviewView, session: Uri | undefined): void;
	}

	export namespace window {
		export function registerChatSessionPanelProvider(id: string, provider: ChatSessionPanelProvider, options?: { readonly webviewOptions?: { readonly retainContextWhenHidden?: boolean } }): Disposable;
	}
}
