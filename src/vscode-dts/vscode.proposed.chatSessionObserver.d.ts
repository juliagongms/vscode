/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// Observe every chat session the editor knows, of every provider, as a provider-neutral,
	// append-only event log: complete history, then live appends, with or without a widget.

	export type ChatSessionObservedStatus = 'working' | 'waiting' | 'question' | 'finished' | 'failed' | 'cancelled';

	/**
	 * What a session's provider can and cannot supply. Consumers must treat a missing
	 * capability as "not available", never as "did not happen".
	 */
	export interface ChatSessionFidelity {
		readonly reasoning: 'full' | 'summary' | 'none';
		readonly toolOutput: 'full' | 'truncated';
		readonly diffs: 'perEdit' | 'perTurn' | 'aggregate' | 'none';
		readonly timestamps: 'perEvent' | 'perTurn';
		readonly modelCalls: boolean;
		readonly liveWithoutWidget: boolean;
		readonly liveLatencyMs: number;
	}

	export interface ChatSessionInfo {
		readonly resource: Uri;
		/** `local`, `copilotCli`, `agentHost`, `cloud`, or a contributed session type. */
		readonly provider: string;
		/** For agent host sessions: `copilot`, `claude`, `codex`, ... */
		readonly harness?: string;
		readonly title: string;
		readonly description?: string;
		readonly status: ChatSessionObservedStatus;
		readonly createdAt: number;
		readonly lastActivityAt: number;
		readonly lastRequestStartedAt?: number;
		readonly lastRequestEndedAt?: number;
		readonly readState: { readonly isRead: boolean; readonly lastReadAt?: number };
		readonly archived: boolean;
		readonly workspace?: { readonly folder?: Uri; readonly worktree?: Uri; readonly repositoryRoot?: Uri };
		readonly repository?: { readonly remoteUrl: string; readonly owner?: string; readonly name?: string; readonly branch?: string; readonly baseBranch?: string; readonly head?: string };
		readonly pullRequest?: { readonly url: string; readonly number: number; readonly title?: string; readonly state?: string };
		readonly changes?: { readonly files: number; readonly insertions: number; readonly deletions: number };
		readonly model?: string;
		readonly mode?: string;
		readonly reasoningEffort?: string;
		readonly parent?: Uri;
		readonly children?: readonly Uri[];
		readonly capabilities: {
			readonly steering: boolean;
			readonly queueing: boolean;
			readonly inputSuggestions: boolean;
			readonly questions: boolean;
			readonly planReview: boolean;
		};
		readonly fidelity: ChatSessionFidelity;
	}

	export interface ChatSessionsChangeEvent {
		readonly added: readonly ChatSessionInfo[];
		readonly removed: readonly Uri[];
		readonly changed: readonly ChatSessionInfo[];
	}

	/** A large payload (tool output, a file version) that resolves on demand. */
	export interface ChatSessionContentRef {
		readonly id: string;
		readonly size: number;
	}

	export interface ChatSessionEventAttachment {
		readonly kind: 'file' | 'selection' | 'directory' | 'image' | 'symbol' | 'url' | 'promptFile' | 'other';
		readonly label: string;
		readonly uri?: Uri;
		readonly range?: Range;
		readonly ref?: ChatSessionContentRef;
	}

	export type ChatSessionUserMessageOrigin = 'user' | 'system' | 'autopilot' | 'notification' | 'skill' | 'extension' | 'agent';

	interface ChatSessionEventBase {
		/** Gapless and ordered per session. */
		readonly seq: number;
		readonly id: string;
		/** Epoch milliseconds. */
		readonly at: number;
		readonly turnId?: string;
		/** Nesting: a subagent's events carry its `subagentStarted` id. */
		readonly parentId?: string;
		/** The provider's own event type, for diagnostics. */
		readonly rawType?: string;
	}

	export type ChatSessionEvent = ChatSessionEventBase & (
		| { readonly kind: 'turnStarted'; readonly trigger: 'user' | 'system' | 'autopilot' | 'steering' | 'queued' }
		| {
			readonly kind: 'userMessage'; readonly text: string; readonly origin: ChatSessionUserMessageOrigin;
			readonly submitKind?: 'send' | 'steer' | 'queue'; readonly attachments: readonly ChatSessionEventAttachment[];
			readonly model?: string; readonly mode?: string; readonly reasoningEffort?: string; readonly hiddenFromTranscript?: boolean;
		}
		| { readonly kind: 'agentText'; readonly text: string; readonly final: boolean }
		| { readonly kind: 'reasoning'; readonly text?: string; readonly availability: 'full' | 'summary' | 'redacted' | 'none'; readonly durationMs?: number }
		| { readonly kind: 'toolCall'; readonly callId: string; readonly name: string; readonly displayName?: string; readonly input: unknown; readonly contributor?: string }
		| { readonly kind: 'toolOutput'; readonly callId: string; readonly stream?: 'stdout' | 'stderr' | 'content'; readonly text?: string; readonly ref?: ChatSessionContentRef; readonly totalChars: number; readonly truncated: boolean }
		| {
			readonly kind: 'toolResult'; readonly callId: string; readonly status: 'completed' | 'failed' | 'cancelled' | 'denied' | 'timedOut';
			readonly exitCode?: number; readonly durationMs?: number; readonly error?: string; readonly structured?: unknown;
		}
		| {
			readonly kind: 'edit'; readonly callId?: string; readonly uri: Uri; readonly operation: 'modify' | 'create' | 'delete' | 'rename'; readonly newUri?: Uri;
			readonly before?: ChatSessionContentRef; readonly after?: ChatSessionContentRef; readonly unifiedDiff: string; readonly added: number; readonly removed: number;
		}
		| { readonly kind: 'editDecision'; readonly uris: readonly Uri[]; readonly decision: 'kept' | 'undone' | 'modifiedByUser' }
		| { readonly kind: 'question'; readonly questionId: string; readonly questions: readonly { readonly text: string; readonly kind: 'single' | 'multi' | 'text'; readonly options?: readonly string[] }[] }
		| { readonly kind: 'questionAnswer'; readonly questionId: string; readonly answers: readonly { readonly selected?: readonly string[]; readonly text?: string }[]; readonly actor: 'user' | 'auto' }
		| { readonly kind: 'planReview'; readonly reviewId: string; readonly title: string; readonly plan: string; readonly planUri?: Uri; readonly actions: readonly string[]; readonly canProvideFeedback: boolean }
		| { readonly kind: 'planReviewDecision'; readonly reviewId: string; readonly action: string; readonly feedback?: string }
		| { readonly kind: 'permission'; readonly permissionId: string; readonly callId?: string; readonly title: string; readonly detail?: string; readonly options?: readonly string[] }
		| { readonly kind: 'permissionDecision'; readonly permissionId: string; readonly decision: 'allowed' | 'denied' | 'auto'; readonly option?: string }
		| { readonly kind: 'todos'; readonly items: readonly { readonly id: string; readonly title: string; readonly status: 'not-started' | 'in-progress' | 'completed' }[] }
		| { readonly kind: 'subagentStarted'; readonly childSession?: Uri; readonly name: string; readonly description?: string; readonly callId?: string }
		| { readonly kind: 'subagentEnded'; readonly childSession?: Uri; readonly callId?: string; readonly status: 'completed' | 'failed' | 'cancelled'; readonly summary?: string }
		| { readonly kind: 'compaction'; readonly summary: string; readonly coversThroughSeq: number; readonly trigger: 'auto' | 'manual' }
		| { readonly kind: 'modelCall'; readonly model: string; readonly reasoningEffort?: string; readonly inputTokens?: number; readonly outputTokens?: number }
		| { readonly kind: 'modelChanged'; readonly model: string; readonly reasoningEffort?: string }
		| { readonly kind: 'modeChanged'; readonly mode: string }
		| { readonly kind: 'notification'; readonly text: string; readonly source: string }
		| { readonly kind: 'pullRequest'; readonly url: string; readonly number: number; readonly title?: string; readonly action: 'opened' | 'updated' | 'linked' }
		| { readonly kind: 'error'; readonly message: string; readonly code?: string; readonly details?: string; readonly resumable?: boolean }
		| { readonly kind: 'turnEnded'; readonly outcome: 'completed' | 'needsInput' | 'cancelled' | 'failed'; readonly cancelledBy?: 'user' | 'system'; readonly reason?: string }
		| { readonly kind: 'pending'; readonly items: readonly { readonly id: string; readonly kind: 'queued' | 'steering'; readonly text: string; readonly at: number }[] }
		| { readonly kind: 'input'; readonly textLength: number; readonly text?: string }
		| { readonly kind: 'transcriptVisibility'; readonly visible: boolean }
	);

	export interface ChatSessionObservation extends Disposable {
		readonly info: ChatSessionInfo;
		/** The full log so far, in `seq` order. */
		readonly events: readonly ChatSessionEvent[];
		readonly onDidAppend: Event<readonly ChatSessionEvent[]>;
		readonly onDidChangeInfo: Event<ChatSessionInfo>;
		fetchContent(ref: ChatSessionContentRef): Thenable<string>;
	}

	/** Where a chat surface shows a session, in this window. */
	export interface ActiveChatSession {
		readonly resource: Uri;
		readonly host: 'chatView' | 'chatEditor' | 'quickChat' | 'agentsWindow' | 'inbox';
		readonly windowKind: 'editor' | 'agents';
		readonly windowFocused: boolean;
		readonly inputFocused: boolean;
	}

	export namespace chat {
		/** Every session the editor knows, all providers, open in a widget or not. */
		export function getChatSessions(filter?: { readonly activeSince?: number }): Thenable<readonly ChatSessionInfo[]>;
		export const onDidChangeChatSessions: Event<ChatSessionsChangeEvent>;
		/**
		 * The full transcript plus a live subscription. Works headlessly (no widget).
		 * `fromSeq` resumes after a reload.
		 */
		export function observeChatSession(resource: Uri, options?: { readonly fromSeq?: number }): Thenable<ChatSessionObservation>;
		/** Which session each chat surface in this window shows, and whether it has focus. */
		export const activeChatSessions: readonly ActiveChatSession[];
		export const onDidChangeActiveChatSessions: Event<readonly ActiveChatSession[]>;
		/** Focus a session in the surface where it lives (opening it when needed). */
		export function openChatSession(resource: Uri): Thenable<void>;
		/** Open the session and scroll to the turn or part an event belongs to. */
		export function revealChatSessionEvent(resource: Uri, eventId: string): Thenable<void>;
		/** A diff editor with the before and after of an `edit` event. */
		export function openChatSessionEditDiff(resource: Uri, eventId: string): Thenable<void>;
	}
}
