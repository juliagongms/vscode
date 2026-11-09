/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// A third pending-request kind, `Draft`: shown in a session's pending list beside Steering
	// and Queued, never sent on its own. The user edits it, makes it a steering or queued
	// message, or discards it.

	export interface ChatDraftRequest {
		readonly id: string;
		readonly text: string;
		/** The divider label, e.g. "Suggested by Rudder". */
		readonly label: string;
		/** One line under the draft: why it was suggested. */
		readonly detail?: string;
		/** Show a warning badge: the draft relays someone else's instruction. */
		readonly warning?: string;
	}

	export type ChatDraftRequestOutcome = 'steered' | 'queued' | 'sent' | 'discarded' | 'expired';

	export interface ChatDraftRequestResolution {
		readonly outcome: ChatDraftRequestOutcome;
		/** The text that was sent or queued, after any edits. */
		readonly finalText?: string;
		readonly edited: boolean;
		/** For `discarded`: the reason chip the user picked, if any. */
		readonly reason?: string;
		/** The request the draft became, for `steered` / `queued` / `sent`. */
		readonly requestId?: string;
	}

	export interface ChatDraftRequestHandle extends Disposable {
		readonly id: string;
		update(draft: Partial<Omit<ChatDraftRequest, 'id'>>): void;
		readonly onDidChangeState: Event<{ readonly state: 'shown' | 'hidden' | 'editing'; readonly host: ActiveChatSession['host'] }>;
		readonly onDidResolve: Event<ChatDraftRequestResolution>;
	}

	export namespace chat {
		/** Add a draft to a session's pending list. One per session per extension: a new one replaces the old. */
		export function addChatDraftRequest(session: Uri, draft: ChatDraftRequest): ChatDraftRequestHandle;
	}
}
