/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { IChatDraftRequestService, IChatInputSuggestion, IChatInputSuggestionService, IChatSessionContentRef, IChatSessionObserverService, IChatSessionTranscript } from '../../contrib/chat/common/sessionObserver/chatSessionObserver.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostChatSessionObserverShape, ExtHostContext, MainContext, MainThreadChatSessionObserverShape } from '../common/extHost.protocol.js';

/**
 * Proposed APIs `chatSessionObserver`, `chatInputSuggestion` and `chatDraftRequests`: the
 * session event log, ghost-text suggestions and drafts, for one extension host.
 */
@extHostNamedCustomer(MainContext.MainThreadChatSessionObserver)
export class MainThreadChatSessionObserver extends Disposable implements MainThreadChatSessionObserverShape {

	private readonly proxy: ExtHostChatSessionObserverShape;
	private readonly observations = this._register(new DisposableMap<number, IChatSessionTranscript>());
	private readonly observationListeners = this._register(new DisposableMap<number, DisposableStore>());
	private listening = false;
	/** Suggestions and drafts are owned per extension host; the owner id keeps hosts apart. */
	private readonly owner: string;
	private readonly drafts = new Set<string>();

	constructor(
		extHostContext: IExtHostContext,
		@IChatSessionObserverService private readonly observer: IChatSessionObserverService,
		@IChatInputSuggestionService private readonly suggestions: IChatInputSuggestionService,
		@IChatDraftRequestService private readonly draftService: IChatDraftRequestService,
	) {
		super();
		this.proxy = extHostContext.getProxy(ExtHostContext.ExtHostChatSessionObserver);
		this.owner = `exthost:${extHostContext.extensionHostKind}:${Math.random().toString(36).slice(2)}`;
		this._register(this.suggestions.onDidChangeSuggestionState(e => {
			if (e.owner === this.owner) {
				this.proxy.$onDidChangeChatInputSuggestion(e);
			}
		}));
		this._register(this.suggestions.onDidSubmitRequest(e => {
			this.proxy.$onDidSubmitChatRequest({
				...e,
				...(e.fromSuggestion && e.fromSuggestion.owner !== this.owner ? { fromSuggestion: undefined } : {}),
				...(e.fromDraft && e.fromDraft.owner !== this.owner ? { fromDraft: undefined } : {}),
			});
		}));
		this._register(this.draftService.onDidChangeDraftState(e => {
			if (e.draft.owner === this.owner) {
				this.proxy.$onDidChangeDraftState(e.draft.id, e.state, e.host);
			}
		}));
		this._register(this.draftService.onDidResolveDraft(e => {
			if (e.draft.owner === this.owner) {
				this.drafts.delete(e.draft.id);
				this.proxy.$onDidResolveDraft(e.draft.id, { outcome: e.outcome, edited: e.edited, ...(e.finalText !== undefined ? { finalText: e.finalText } : {}), ...(e.reason ? { reason: e.reason } : {}), ...(e.requestId ? { requestId: e.requestId } : {}) });
			}
		}));
	}

	async $startListening() {
		if (!this.listening) {
			this.listening = true;
			this._register(this.observer.onDidChangeSessions(e => this.proxy.$onDidChangeChatSessions(e)));
			this._register(this.observer.onDidChangeActiveSessions(a => this.proxy.$onDidChangeActiveChatSessions([...a])));
		}
		return [...this.observer.activeSessions];
	}

	async $getChatSessions(activeSince: number | undefined) {
		return [...await this.observer.getSessions(activeSince)];
	}

	async $observeChatSession(handle: number, resource: UriComponents, fromSeq: number | undefined) {
		const t = await this.observer.observe(URI.revive(resource));
		this.observations.set(handle, t);
		const store = new DisposableStore();
		store.add(t.onDidAppend(events => this.proxy.$onDidAppend(handle, [...events])));
		store.add(t.onDidChangeInfo(info => this.proxy.$onDidChangeInfo(handle, info)));
		this.observationListeners.set(handle, store);
		const events = fromSeq ? t.events.filter(e => e.seq > fromSeq) : t.events;
		return { info: t.info, events: [...events] };
	}

	$disposeObservation(handle: number): void {
		this.observationListeners.deleteAndDispose(handle);
		this.observations.deleteAndDispose(handle);
	}

	async $fetchContent(handle: number, ref: IChatSessionContentRef): Promise<string> {
		return this.observations.get(handle)?.fetchContent(ref) ?? '';
	}

	$openChatSession(resource: UriComponents): Promise<void> {
		return this.observer.openSession(URI.revive(resource));
	}

	$revealChatSessionEvent(resource: UriComponents, eventId: string): Promise<void> {
		return this.observer.revealEvent(URI.revive(resource), eventId);
	}

	$openChatSessionEditDiff(resource: UriComponents, eventId: string): Promise<void> {
		return this.observer.openEditDiff(URI.revive(resource), eventId);
	}

	$setChatInputSuggestion(resource: UriComponents, suggestion: IChatInputSuggestion | undefined): void {
		this.suggestions.setSuggestion(this.owner, URI.revive(resource), suggestion);
	}

	$addChatDraftRequest(resource: UriComponents, draft: { id: string; text: string; label: string; detail?: string; warning?: string }): void {
		this.drafts.add(draft.id);
		this.draftService.setDraft({ ...draft, owner: this.owner, session: URI.revive(resource), createdAt: Date.now() });
	}

	$updateChatDraftRequest(id: string, patch: { text?: string; label?: string; detail?: string; warning?: string }): void {
		this.draftService.updateDraft(id, patch);
	}

	$disposeChatDraftRequest(id: string): void {
		if (this.drafts.delete(id)) {
			this.draftService.resolveDraft(id, 'expired', { reason: 'withdrawn' });
		}
	}

	override dispose(): void {
		for (const id of [...this.drafts]) {
			this.draftService.resolveDraft(id, 'expired', { reason: 'extension_host_ended' });
		}
		super.dispose();
	}
}
