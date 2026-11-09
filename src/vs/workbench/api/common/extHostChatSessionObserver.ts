/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { revive } from '../../../base/common/marshalling.js';
import { URI } from '../../../base/common/uri.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ExtHostChatSessionObserverShape, IMainContext, MainContext, MainThreadChatSessionObserverShape } from './extHost.protocol.js';
import { ExtHostWebviewViews } from './extHostWebviewView.js';
import { Range } from './extHostTypes.js';

type Info = vscode.ChatSessionInfo;
type Event_ = vscode.ChatSessionEvent;

function toApiEvent(raw: unknown): Event_ {
	const e = revive(raw) as Record<string, unknown>;
	if (e.kind === 'userMessage' && Array.isArray(e.attachments)) {
		e.attachments = (e.attachments as Record<string, unknown>[]).map(a => {
			const r = a.range as { startLineNumber: number; endLineNumber: number } | undefined;
			return r ? { ...a, range: new Range(r.startLineNumber - 1, 0, r.endLineNumber - 1, 0) } : a;
		});
	}
	return Object.freeze(e) as unknown as Event_;
}

class Observation extends Disposable implements vscode.ChatSessionObservation {
	readonly events: Event_[];
	readonly _onDidAppend = this._register(new Emitter<readonly Event_[]>());
	readonly onDidAppend = this._onDidAppend.event;
	readonly _onDidChangeInfo = this._register(new Emitter<Info>());
	readonly onDidChangeInfo = this._onDidChangeInfo.event;

	constructor(public info: Info, events: Event_[], private readonly fetch: (ref: vscode.ChatSessionContentRef) => Thenable<string>, private readonly onDispose: () => void) {
		super();
		this.events = events;
	}

	fetchContent(ref: vscode.ChatSessionContentRef): Thenable<string> {
		return this.fetch(ref);
	}

	override dispose(): void {
		this.onDispose();
		super.dispose();
	}
}

export class ExtHostChatSessionObserver implements ExtHostChatSessionObserverShape {
	private readonly proxy: MainThreadChatSessionObserverShape;
	private readonly observations = new Map<number, Observation>();
	private nextHandle = 1;
	private active: readonly vscode.ActiveChatSession[] = [];
	private started: Promise<void> | undefined;

	private readonly _onDidChangeChatSessions = new Emitter<vscode.ChatSessionsChangeEvent>({ onWillAddFirstListener: () => void this.start() });
	readonly onDidChangeChatSessions = this._onDidChangeChatSessions.event;
	private readonly _onDidChangeActiveChatSessions = new Emitter<readonly vscode.ActiveChatSession[]>({ onWillAddFirstListener: () => void this.start() });
	readonly onDidChangeActiveChatSessions = this._onDidChangeActiveChatSessions.event;
	private readonly _onDidChangeChatInputSuggestion = new Emitter<vscode.ChatInputSuggestionEvent>();
	readonly onDidChangeChatInputSuggestion = this._onDidChangeChatInputSuggestion.event;
	private readonly _onDidSubmitChatRequest = new Emitter<vscode.ChatRequestSubmission>();
	readonly onDidSubmitChatRequest = this._onDidSubmitChatRequest.event;
	private readonly drafts = new Map<string, { state: Emitter<{ state: 'shown' | 'hidden' | 'editing'; host: vscode.ActiveChatSession['host'] }>; resolve: Emitter<vscode.ChatDraftRequestResolution> }>();

	constructor(mainContext: IMainContext, private readonly webviewViews: ExtHostWebviewViews) {
		this.proxy = mainContext.getProxy(MainContext.MainThreadChatSessionObserver);
	}

	private start(): Promise<void> {
		this.started ??= this.proxy.$startListening().then(active => {
			this.active = revive(active) as vscode.ActiveChatSession[];
		});
		return this.started;
	}

	// ---- chatSessionObserver ----

	async getChatSessions(filter?: { readonly activeSince?: number }): Promise<readonly Info[]> {
		void this.start();
		return revive(await this.proxy.$getChatSessions(filter?.activeSince)) as Info[];
	}

	async observeChatSession(resource: vscode.Uri, options?: { readonly fromSeq?: number }): Promise<vscode.ChatSessionObservation> {
		const handle = this.nextHandle++;
		const { info, events } = await this.proxy.$observeChatSession(handle, resource, options?.fromSeq);
		const obs = new Observation(revive(info) as Info, events.map(toApiEvent), ref => this.proxy.$fetchContent(handle, ref), () => {
			this.observations.delete(handle);
			this.proxy.$disposeObservation(handle);
		});
		this.observations.set(handle, obs);
		return obs;
	}

	get activeChatSessions(): readonly vscode.ActiveChatSession[] {
		void this.start();
		return this.active;
	}

	openChatSession(resource: vscode.Uri): Thenable<void> {
		return this.proxy.$openChatSession(resource);
	}

	revealChatSessionEvent(resource: vscode.Uri, eventId: string): Thenable<void> {
		return this.proxy.$revealChatSessionEvent(resource, eventId);
	}

	openChatSessionEditDiff(resource: vscode.Uri, eventId: string): Thenable<void> {
		return this.proxy.$openChatSessionEditDiff(resource, eventId);
	}

	$onDidChangeChatSessions(e: unknown): void {
		this._onDidChangeChatSessions.fire(revive(e) as vscode.ChatSessionsChangeEvent);
	}

	$onDidChangeActiveChatSessions(active: unknown[]): void {
		this.active = Object.freeze(revive(active) as vscode.ActiveChatSession[]);
		this._onDidChangeActiveChatSessions.fire(this.active);
	}

	$onDidAppend(handle: number, events: unknown[]): void {
		const obs = this.observations.get(handle);
		if (obs) {
			const mapped = events.map(toApiEvent);
			obs.events.push(...mapped);
			obs._onDidAppend.fire(mapped);
		}
	}

	$onDidChangeInfo(handle: number, info: unknown): void {
		const obs = this.observations.get(handle);
		if (obs) {
			obs.info = revive(info) as Info;
			obs._onDidChangeInfo.fire(obs.info);
		}
	}

	// ---- chatInputSuggestion ----

	setChatInputSuggestion(session: vscode.Uri, suggestion: vscode.ChatInputSuggestion | undefined): void {
		this.proxy.$setChatInputSuggestion(session, suggestion ? {
			id: suggestion.id,
			...(suggestion.validForTurn ? { validForTurn: suggestion.validForTurn } : {}),
			...(suggestion.text !== undefined ? { text: suggestion.text } : {}),
			...(suggestion.answer ? { answer: { ...suggestion.answer, ...(suggestion.answer.selectedOptions ? { selectedOptions: [...suggestion.answer.selectedOptions] } : {}) } } : {}),
		} : undefined);
	}

	$onDidChangeChatInputSuggestion(e: unknown): void {
		const ev = revive(e) as vscode.ChatInputSuggestionEvent & { owner?: string };
		const { owner: _owner, ...rest } = ev;
		this._onDidChangeChatInputSuggestion.fire(rest);
	}

	$onDidSubmitChatRequest(e: unknown): void {
		const ev = revive(e) as vscode.ChatRequestSubmission & { fromSuggestion?: { owner?: string }; fromDraft?: { owner?: string } };
		this._onDidSubmitChatRequest.fire({
			...ev,
			...(ev.fromSuggestion ? { fromSuggestion: { id: (ev.fromSuggestion as { id: string }).id, acceptedChars: (ev.fromSuggestion as { acceptedChars: number }).acceptedChars } } : {}),
			...(ev.fromDraft ? { fromDraft: { id: (ev.fromDraft as { id: string }).id } } : {}),
		});
	}

	// ---- chatDraftRequests ----

	addChatDraftRequest(session: vscode.Uri, draft: vscode.ChatDraftRequest): vscode.ChatDraftRequestHandle {
		const state = new Emitter<{ state: 'shown' | 'hidden' | 'editing'; host: vscode.ActiveChatSession['host'] }>();
		const resolve = new Emitter<vscode.ChatDraftRequestResolution>();
		this.drafts.set(draft.id, { state, resolve });
		this.proxy.$addChatDraftRequest(session, { id: draft.id, text: draft.text, label: draft.label, ...(draft.detail ? { detail: draft.detail } : {}), ...(draft.warning ? { warning: draft.warning } : {}) });
		let disposed = false;
		return {
			id: draft.id,
			update: patch => this.proxy.$updateChatDraftRequest(draft.id, { ...patch }),
			onDidChangeState: state.event,
			onDidResolve: resolve.event,
			dispose: () => {
				if (!disposed) {
					disposed = true;
					this.proxy.$disposeChatDraftRequest(draft.id);
					this.drafts.delete(draft.id);
					state.dispose();
					resolve.dispose();
				}
			},
		};
	}

	$onDidChangeDraftState(id: string, state: 'shown' | 'hidden' | 'editing', host: string): void {
		this.drafts.get(id)?.state.fire({ state, host: host as vscode.ActiveChatSession['host'] });
	}

	$onDidResolveDraft(id: string, resolution: { outcome: string; finalText?: string; edited: boolean; reason?: string; requestId?: string }): void {
		const d = this.drafts.get(id);
		if (d) {
			d.resolve.fire(resolution as vscode.ChatDraftRequestResolution);
			this.drafts.delete(id);
		}
	}

	// ---- chatSessionPanel ----

	registerChatSessionPanelProvider(extension: IExtensionDescription, id: string, provider: vscode.ChatSessionPanelProvider, options?: { readonly webviewOptions?: { readonly retainContextWhenHidden?: boolean } }): vscode.Disposable {
		const store = new DisposableStore();
		const current = (): URI | undefined => {
			const a = this.active.find(x => x.windowFocused) ?? this.active[0];
			return a?.resource;
		};
		let view: vscode.WebviewView | undefined;
		let shown: string | undefined;
		store.add(this.onDidChangeActiveChatSessions(() => {
			const s = current();
			if (view && s?.toString() !== shown) {
				shown = s?.toString();
				provider.onDidChangeChatSessionPanelSession?.(view, s);
			}
		}));
		store.add(this.webviewViews.registerWebviewViewProvider(extension, id, {
			resolveWebviewView: async (v, _ctx, token) => {
				await this.start();
				view = v;
				const s = current();
				shown = s?.toString();
				v.onDidDispose(() => { view = undefined; });
				return provider.resolveChatSessionPanel(v, s, token ?? CancellationToken.None);
			},
		}, options?.webviewOptions));
		return toDisposable(() => store.dispose());
	}
}

