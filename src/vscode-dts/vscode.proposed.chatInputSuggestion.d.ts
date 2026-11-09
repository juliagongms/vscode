/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// Push a suggested next message for one session's chat input. Core renders it as ghost
	// text in every input bound to that session; Tab puts it in the box, never sends it.

	export interface ChatInputSuggestion {
		readonly id: string;
		/** The request that handed back; the suggestion is invalid once another starts. */
		readonly validForTurn?: string;
		/** Ghost text for the chat input. */
		readonly text?: string;
		/** For an open question or plan review: the options to mark as suggested, and free-form text. */
		readonly answer?: {
			readonly questionId?: string;
			readonly reviewId?: string;
			readonly selectedOptions?: readonly string[];
			readonly freeform?: string;
		};
	}

	export type ChatInputSuggestionState = 'shown' | 'hidden' | 'accepted' | 'partiallyAccepted' | 'rejected' | 'superseded' | 'invalidated';

	export interface ChatInputSuggestionEvent {
		readonly id: string;
		readonly session: Uri;
		readonly state: ChatInputSuggestionState;
		/** For `accepted` / `partiallyAccepted`: how many characters went into the input. */
		readonly acceptedChars?: number;
		readonly host: ActiveChatSession['host'];
		/** For `hidden` before it was ever shown: why (e.g. `userTypedFirst`). */
		readonly reason?: string;
	}

	export interface ChatRequestSubmission {
		readonly session: Uri;
		readonly requestId: string;
		readonly text: string;
		readonly kind: 'send' | 'steer' | 'queue' | 'answer' | 'planDecision';
		readonly host: ActiveChatSession['host'];
		/** Set by core when the submitted text came through accepting a suggestion. */
		readonly fromSuggestion?: { readonly id: string; readonly acceptedChars: number };
		/** Set by core when the submitted text came from a draft request. */
		readonly fromDraft?: { readonly id: string };
	}

	export namespace chat {
		/** Set (or clear, with `undefined`) the suggestion for a session's input. */
		export function setChatInputSuggestion(session: Uri, suggestion: ChatInputSuggestion | undefined): void;
		export const onDidChangeChatInputSuggestion: Event<ChatInputSuggestionEvent>;
		/** Every request the user submits to any session, in this window. */
		export const onDidSubmitChatRequest: Event<ChatRequestSubmission>;
	}
}
