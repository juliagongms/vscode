/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { InlineCompletion, InlineCompletionContext, InlineCompletionEndOfLifeReason, InlineCompletionEndOfLifeReasonKind, InlineCompletions, InlineCompletionsProvider } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { InlineCompletionsController } from '../../../../../editor/contrib/inlineCompletions/browser/controller/inlineCompletionsController.js';
import { ChatRequestQueueKind, IChatService } from '../../common/chatService/chatService.js';
import { ActiveChatSessionHost, ChatInputSuggestionState, IChatDraftRequestService, IChatInputSuggestion, IChatInputSuggestionEvent, IChatInputSuggestionService, IChatRequestSubmission, IChatSessionObserverService } from '../../common/sessionObserver/chatSessionObserver.js';
import { IChatWidget, IChatWidgetService } from '../chat.js';
import { chatInputInlineCompletionsSetting } from '../widget/input/editor/chatInputInlineSuggestions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

interface IEntry {
	readonly owner: string;
	readonly suggestion: IChatInputSuggestion;
	shown: boolean;
	accepted?: { chars: number; text: string };
}

interface ISuggestionItem extends InlineCompletion {
	readonly suggestionId: string;
	readonly session: URI;
	readonly prefixLength: number;
}

interface ISuggestionList extends InlineCompletions<ISuggestionItem> {
	readonly items: readonly ISuggestionItem[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trimStart().toLowerCase();

/** The ghost text: the suggested message, or for an answer, the picked options and any added words. */
function suggestionText(s: IChatInputSuggestion): string {
	if (s.text) {
		return s.text;
	}
	const a = s.answer;
	return a ? [a.selectedOptions?.join(', '), a.freeform].filter(Boolean).join(' — ') : '';
}

/**
 * Pushed input suggestions (proposed API `chatInputSuggestion`): ghost text in every chat
 * input bound to the session, rendered by the input's own inline-completions controller.
 * Tab puts it in the box; it is never sent on its own.
 */
export class ChatInputSuggestionService extends Disposable implements IChatInputSuggestionService {
	declare readonly _serviceBrand: undefined;

	private readonly entries = new ResourceMap<IEntry>();
	private readonly _onDidChangeSuggestions = this._register(new Emitter<URI>());
	readonly onDidChangeSuggestions = this._onDidChangeSuggestions.event;
	private readonly _onDidChangeSuggestionState = this._register(new Emitter<IChatInputSuggestionEvent>());
	readonly onDidChangeSuggestionState = this._onDidChangeSuggestionState.event;
	private readonly _onDidSubmitRequest = this._register(new Emitter<IChatRequestSubmission>());
	readonly onDidSubmitRequest = this._onDidSubmitRequest.event;

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatService chatService: IChatService,
		@IChatSessionObserverService private readonly observer: IChatSessionObserverService,
		@IChatDraftRequestService private readonly drafts: IChatDraftRequestService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const provider: InlineCompletionsProvider<ISuggestionList> = {
			groupId: 'chatInputSuggestion',
			provideInlineCompletions: (model, position, context, token) => this.provide(model, position, context, token),
			handleItemDidShow: (_list, item) => this.onShown(item),
			handlePartialAccept: (_list, item, _chars, info) => this.onAccepted(item, info.acceptedLength, true),
			handleEndOfLifetime: (_list, item, reason) => this.onEnd(item, reason),
			disposeInlineCompletions: () => { },
		};
		for (const scheme of [Schemas.vscodeChatInput, Schemas.sessionsChatInput]) {
			this._register(languageFeaturesService.inlineCompletionsProvider.register({ scheme }, provider));
		}

		// Chat inputs keep inline suggestions off unless Copilot's chat completions are on; a
		// pushed suggestion turns them on for the inputs bound to its session, while it lasts.
		const bindWidget = (w: IChatWidget) => {
			if (!this.focusListeners.has(w)) {
				this.focusListeners.set(w, w.inputEditor.onDidFocusEditorText(() => this.showIn(w)));
			}
		};
		this.chatWidgetService.getAllWidgets().forEach(bindWidget);
		this._register(this.chatWidgetService.onDidAddWidget(bindWidget));

		// Every new submission: report it, and tie it to the suggestion or draft it came from.
		this._register(chatService.onDidAcceptRequest(e => {
			if (e.text === undefined) {
				return;
			}
			const session = e.chatSessionResource;
			const entry = this.entries.get(session);
			const draft = this.drafts.editingDraft(session);
			const kind = e.queue === ChatRequestQueueKind.Steering ? 'steer' : e.queue === ChatRequestQueueKind.Queued ? 'queue' : 'send';
			const fromSuggestion = entry?.accepted && norm(e.text).startsWith(norm(entry.accepted.text).slice(0, Math.max(1, Math.min(entry.accepted.chars, 20))))
				? { id: entry.suggestion.id, owner: entry.owner, acceptedChars: entry.accepted.chars }
				: undefined;
			const requestId = generateUuid();
			this._onDidSubmitRequest.fire({
				session, requestId, text: e.text, kind, host: this.hostFor(session),
				...(fromSuggestion ? { fromSuggestion } : {}), ...(draft ? { fromDraft: { id: draft.id, owner: draft.owner } } : {}),
			});
			if (draft) {
				this.drafts.resolveDraft(draft.id, kind === 'steer' ? 'steered' : kind === 'queue' ? 'queued' : 'sent', { finalText: e.text, edited: norm(e.text) !== norm(draft.text), requestId });
			}
			// Any submission ends the suggestion's life.
			if (entry) {
				this.entries.delete(session);
				this._onDidChangeSuggestions.fire(session);
				this.restore(session);
			}
		}));
	}

	private readonly focusListeners = this._register(new DisposableMap<IChatWidget>());

	/** Shows the session's suggestion in a widget's input, enabling inline suggestions there. */
	private showIn(w: IChatWidget): void {
		const session = w.viewModel?.sessionResource;
		if (!session || !this.entries.has(session)) {
			return;
		}
		w.inputEditor.updateOptions({ inlineSuggest: { enabled: true } });
		InlineCompletionsController.get(w.inputEditor)?.model.get()?.trigger();
	}

	/** Restores the configured inline-suggestion setting on the inputs bound to a session. */
	private restore(session: URI): void {
		const enabled = this.configurationService.getValue<boolean>(chatInputInlineCompletionsSetting) === true;
		for (const w of this.chatWidgetService.getAllWidgets()) {
			if (w.viewModel?.sessionResource.toString() === session.toString()) {
				w.inputEditor.updateOptions({ inlineSuggest: { enabled } });
			}
		}
	}

	private hostFor(session: URI): ActiveChatSessionHost {
		return this.observer.activeSessions.find(a => a.resource.toString() === session.toString())?.host ?? 'chatView';
	}

	private widgetFor(model: ITextModel): IChatWidget | undefined {
		return this.chatWidgetService.getAllWidgets().find(w => w.inputEditor.getModel() === model);
	}

	setSuggestion(owner: string, session: URI, suggestion: IChatInputSuggestion | undefined): void {
		const prev = this.entries.get(session);
		if (prev && (!suggestion || prev.suggestion.id !== suggestion.id)) {
			this.fire(session, prev, suggestion ? 'superseded' : 'invalidated');
		}
		if (suggestion) {
			this.entries.set(session, { owner, suggestion, shown: false });
		} else {
			this.entries.delete(session);
		}
		this._onDidChangeSuggestions.fire(session);
		if (!suggestion) {
			this.restore(session);
			return;
		}
		// Show it at once in an input that is focused and empty (or a prefix), in every widget on the session.
		for (const w of this.chatWidgetService.getAllWidgets()) {
			if (w.viewModel?.sessionResource.toString() === session.toString() && w.inputEditor.hasTextFocus()) {
				this.showIn(w);
			}
		}
	}

	getSuggestion(session: URI): (IChatInputSuggestion & { readonly owner: string }) | undefined {
		const e = this.entries.get(session);
		return e ? { ...e.suggestion, owner: e.owner } : undefined;
	}

	reportState(session: URI, id: string, state: ChatInputSuggestionState, host: ActiveChatSessionHost, details?: { acceptedChars?: number; reason?: string }): void {
		const e = this.entries.get(session);
		if (e && e.suggestion.id === id) {
			this._onDidChangeSuggestionState.fire({ id, session, owner: e.owner, state, host, ...details });
		}
	}

	private fire(session: URI, e: IEntry, state: ChatInputSuggestionState, details?: { acceptedChars?: number; reason?: string }): void {
		this._onDidChangeSuggestionState.fire({ id: e.suggestion.id, session, owner: e.owner, state, host: this.hostFor(session), ...details });
	}

	private provide(model: ITextModel, position: Position, _context: InlineCompletionContext, _token: CancellationToken): ISuggestionList | undefined {
		const widget = this.widgetFor(model);
		const session = widget?.viewModel?.sessionResource;
		// A session with no turn yet (a new-session composer) has nothing to reply to.
		if (!session || !widget?.viewModel?.model.hasRequests) {
			return undefined;
		}
		const entry = this.entries.get(session);
		const text = entry ? suggestionText(entry.suggestion) : undefined;
		if (!entry || !text) {
			return undefined;
		}
		const current = model.getValue();
		const end = model.getFullModelRange().getEndPosition();
		if (!position.equals(end)) {
			return undefined;
		}
		// Shown only on an empty input, or one holding a prefix of the suggestion; never over other text.
		if (current.trim() && !norm(text).startsWith(norm(current))) {
			if (!entry.shown) {
				this.fire(session, entry, 'hidden', { reason: 'userTypedFirst' });
			}
			return undefined;
		}
		const insertText = current && text.toLowerCase().startsWith(current.toLowerCase()) ? current + text.slice(current.length) : text;
		const item: ISuggestionItem = {
			insertText,
			range: new Range(1, 1, end.lineNumber, end.column),
			suggestionId: entry.suggestion.id,
			session,
			prefixLength: current.length,
		};
		return { items: [item], enableForwardStability: true };
	}

	private onShown(item: ISuggestionItem): void {
		const e = this.entries.get(item.session);
		if (e && e.suggestion.id === item.suggestionId && !e.shown) {
			e.shown = true;
			this.fire(item.session, e, 'shown');
		}
	}

	private onAccepted(item: ISuggestionItem, chars: number, partial: boolean): void {
		const e = this.entries.get(item.session);
		if (e && e.suggestion.id === item.suggestionId) {
			const accepted = Math.max(0, chars);
			e.accepted = { chars: accepted, text: suggestionText(e.suggestion).slice(0, item.prefixLength + accepted) };
			this.fire(item.session, e, partial ? 'partiallyAccepted' : 'accepted', { acceptedChars: accepted });
		}
	}

	private onEnd(item: ISuggestionItem, reason: InlineCompletionEndOfLifeReason<ISuggestionItem>): void {
		const e = this.entries.get(item.session);
		if (!e || e.suggestion.id !== item.suggestionId) {
			return;
		}
		if (reason.kind === InlineCompletionEndOfLifeReasonKind.Accepted) {
			this.onAccepted(item, suggestionText(e.suggestion).length - item.prefixLength, false);
		} else if (reason.kind === InlineCompletionEndOfLifeReasonKind.Rejected) {
			this.fire(item.session, e, 'rejected');
		} else if (reason.userTypingDisagreed && e.shown) {
			this.fire(item.session, e, 'hidden', { reason: 'userTypingDisagreed' });
		}
	}
}
