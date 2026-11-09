/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChatToolInvocation, IChatToolInvocationSerialized, IChatService, isLegacyChatTerminalToolInvocationData } from '../../common/chatService/chatService.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { IChatModel, IChatRequestModel, IChatResponseModel } from '../../common/model/chatModel.js';
import { ChatSessionObservedStatus, IChatSessionEventAttachment, IChatSessionEventInput, IChatSessionTranscriptSink, IChatSessionTranscriptSource } from '../../common/sessionObserver/chatSessionObserver.js';
import { IChatTodoListService } from '../../common/tools/chatTodoListService.js';
import { IToolResultInputOutputDetails } from '../../common/tools/languageModelToolsService.js';

function text(v: string | IMarkdownString | undefined): string {
	return v === undefined ? '' : typeof v === 'string' ? v : v.value;
}

function lines(s: string): number {
	return s ? s.split('\n').length : 0;
}

/**
 * Projects a `ChatModel` into the event log: every request and every response part, each
 * emitted once when it closes. The source for local sessions, and the fallback for any
 * session whose content is loaded into a `ChatModel`.
 */
export class ChatModelProjector {
	private readonly emitted = new Set<string>();
	private lastPending = '';
	private lastTodos = '';

	constructor(
		private readonly model: IChatModel,
		private readonly sink: IChatSessionTranscriptSink,
		private readonly todos: () => readonly { id: string; title: string; status: 'not-started' | 'in-progress' | 'completed' }[],
	) { }

	get status(): ChatSessionObservedStatus {
		if (this.model.requestNeedsInput.get()) {
			return 'question';
		}
		if (this.model.hasActiveRequest.get()) {
			return 'working';
		}
		const last = this.model.lastRequest?.response;
		return last?.isCanceled ? 'cancelled' : last?.result?.errorDetails ? 'failed' : 'waiting';
	}

	flush(): void {
		const out: IChatSessionEventInput[] = [];
		for (const request of this.model.getRequests()) {
			this.projectRequest(request, out);
		}
		this.projectPending(out);
		this.projectTodos(out);
		if (out.length) {
			this.sink.append(out);
		}
		const last = this.model.lastRequest;
		this.sink.patchInfo({
			status: this.status,
			lastActivityAt: Math.max(this.model.lastMessageDate, last?.response?.completedAt ?? 0),
			...(last ? { lastRequestStartedAt: last.timestamp } : {}),
			...(last?.response?.completedAt ? { lastRequestEndedAt: last.response.completedAt } : {}),
			...(last?.modelId ? { model: last.modelId } : {}),
			...(last?.modeInfo?.telemetryModeName ?? last?.modeInfo?.telemetryModeId ? { mode: (last?.modeInfo?.telemetryModeName ?? last?.modeInfo?.telemetryModeId)! } : {}),
		});
	}

	private once(key: string, fn: () => void): void {
		if (!this.emitted.has(key)) {
			this.emitted.add(key);
			fn();
		}
	}

	private projectRequest(r: IChatRequestModel, out: IChatSessionEventInput[]): void {
		const turnId = `req:${r.id}`;
		const at = r.timestamp;
		this.once(`${turnId}:start`, () => {
			const origin = r.isSystemInitiated ? 'system' : 'user';
			out.push({ id: `${turnId}:start`, at, turnId, kind: 'turnStarted', trigger: r.isSystemInitiated ? 'system' : 'user' });
			out.push({
				id: turnId, at, turnId, kind: 'userMessage', text: r.message.text, origin,
				attachments: r.variableData.variables.map(v => this.attachment(v as unknown as Record<string, unknown>)),
				...(r.modelId ? { model: r.modelId } : {}), ...(r.modeInfo?.telemetryModeName ?? r.modeInfo?.telemetryModeId ? { mode: (r.modeInfo?.telemetryModeName ?? r.modeInfo?.telemetryModeId)! } : {}),
				...(r.isHiddenFromTranscript ? { hiddenFromTranscript: true } : {}),
			});
		});
		const response = r.response;
		if (response) {
			this.projectResponse(response, turnId, out);
		}
	}

	private attachment(v: Record<string, unknown>): IChatSessionEventAttachment {
		const kind = String(v.kind ?? 'other');
		const value = v.value as { uri?: URI; range?: { startLineNumber: number; endLineNumber: number } } | URI | undefined;
		const uri = URI.isUri(value) ? value : URI.isUri(value?.uri) ? value.uri : undefined;
		const range = !URI.isUri(value) && value?.range ? { startLineNumber: value.range.startLineNumber, endLineNumber: value.range.endLineNumber } : undefined;
		const mapped: IChatSessionEventAttachment['kind'] = kind === 'file' || kind === 'implicit' ? (range ? 'selection' : 'file') : kind === 'directory' ? 'directory' : kind === 'image' ? 'image' : kind === 'symbol' ? 'symbol' : kind === 'promptFile' ? 'promptFile' : 'other';
		return { kind: mapped, label: String(v.name ?? kind), ...(uri ? { uri } : {}), ...(range ? { range } : {}) };
	}

	private projectResponse(response: IChatResponseModel, turnId: string, out: IChatSessionEventInput[]): void {
		const parts = response.entireResponse.value;
		const done = response.isComplete;
		let mdStart = -1;
		let md = '';
		const closeMarkdown = (index: number) => {
			if (mdStart >= 0 && md.trim()) {
				const key = `md:${turnId}:${mdStart}`;
				this.once(key, () => out.push({ id: key, at: response.completedAt ?? Date.now(), turnId, kind: 'agentText', text: md, final: true }));
			}
			mdStart = -1;
			md = '';
			void index;
		};
		parts.forEach((part, i) => {
			const closed = done || i < parts.length - 1;
			if (part.kind === 'markdownContent') {
				if (mdStart < 0) {
					mdStart = i;
				}
				md += text(part.content);
				return;
			}
			closeMarkdown(i);
			const at = Date.now();
			switch (part.kind) {
				case 'thinking': {
					if (closed) {
						const key = `th:${turnId}:${i}`;
						const value = Array.isArray(part.value) ? part.value.join('') : part.value ?? '';
						this.once(key, () => out.push({ id: key, at: part.reasoningStartedAt ?? at, turnId, kind: 'reasoning', text: value, availability: value ? 'full' : 'redacted', ...(part.reasoningDurationMs ? { durationMs: part.reasoningDurationMs } : {}) }));
					}
					break;
				}
				case 'toolInvocation':
				case 'toolInvocationSerialized':
					this.projectTool(part, turnId, out);
					break;
				case 'textEditGroup': {
					if (part.done || done) {
						const key = `edit:${turnId}:${i}`;
						this.once(key, () => {
							const inserted = part.edits.flat().map(e => e.text).join('\n');
							const removed = part.edits.flat().reduce((n, e) => n + (e.range.endLineNumber - e.range.startLineNumber + (e.range.endColumn > 1 || e.range.startLineNumber !== e.range.endLineNumber ? 1 : 0)), 0);
							out.push({ id: key, at, turnId, kind: 'edit', uri: part.uri, operation: 'modify', unifiedDiff: `@@ ${part.uri.path} @@\n${inserted.split('\n').map(l => `+${l}`).join('\n')}`, added: lines(inserted), removed });
						});
					}
					break;
				}
				case 'questionCarousel': {
					const qid = part.resolveId ?? `${turnId}:${i}`;
					this.once(`q:${qid}`, () => out.push({
						id: `q:${qid}`, at, turnId, kind: 'question', questionId: qid,
						questions: part.questions.map(q => ({ text: q.title || text(q.message), kind: q.type === 'singleSelect' ? 'single' as const : q.type === 'multiSelect' ? 'multi' as const : 'text' as const, ...(q.options?.length ? { options: q.options.map(o => o.label) } : {}) })),
					}));
					if (part.isUsed || part.data) {
						this.once(`qa:${qid}`, () => out.push({
							id: `qa:${qid}`, at, turnId, kind: 'questionAnswer', questionId: qid, actor: part.answeredExternally ? 'auto' : 'user',
							answers: part.questions.map(q => {
								const a = (part.data as Record<string, unknown> | undefined)?.[q.id] as { selectedValue?: string; selectedValues?: string[]; freeformValue?: string } | string | undefined;
								if (typeof a === 'string') {
									return { text: a };
								}
								const selected = a?.selectedValues ?? (a?.selectedValue ? [a.selectedValue] : undefined);
								return { ...(selected ? { selected: selected.map(v => q.options?.find(o => o.value === v || o.id === v)?.label ?? v) } : {}), ...(a?.freeformValue ? { text: a.freeformValue } : {}) };
							}),
						}));
					}
					break;
				}
				case 'planReview': {
					const rid = part.resolveId ?? `${turnId}:${i}`;
					this.once(`p:${rid}`, () => out.push({ id: `p:${rid}`, at, turnId, kind: 'planReview', reviewId: rid, title: part.title, plan: part.content, ...(part.planUri ? { planUri: URI.revive(part.planUri) } : {}), actions: part.actions.map(a => a.label), canProvideFeedback: part.canProvideFeedback }));
					if (part.data) {
						const d = part.data as { action?: string; feedback?: string };
						this.once(`pd:${rid}`, () => out.push({ id: `pd:${rid}`, at, turnId, kind: 'planReviewDecision', reviewId: rid, action: d.action ?? 'decided', ...(d.feedback ? { feedback: d.feedback } : {}) }));
					}
					break;
				}
				case 'confirmation': {
					const pid = `${turnId}:${i}`;
					this.once(`perm:${pid}`, () => out.push({ id: `perm:${pid}`, at, turnId, kind: 'permission', permissionId: pid, title: part.title, detail: text(part.message), ...(part.buttons ? { options: part.buttons } : {}) }));
					if (part.isUsed) {
						this.once(`permd:${pid}`, () => out.push({ id: `permd:${pid}`, at, turnId, kind: 'permissionDecision', permissionId: pid, decision: 'allowed' }));
					}
					break;
				}
				case 'elicitation2':
				case 'elicitationSerialized': {
					const pid = `${turnId}:${i}`;
					this.once(`perm:${pid}`, () => out.push({ id: `perm:${pid}`, at, turnId, kind: 'permission', permissionId: pid, title: text(part.title), detail: text(part.message) }));
					break;
				}
				case 'pullRequest': {
					const pr = part as unknown as { uri?: URI; title?: string; linkTag?: string };
					const url = pr.uri?.toString() ?? '';
					const m = /\/pull\/(\d+)/.exec(url);
					if (m) {
						this.once(`pr:${url}`, () => out.push({ id: `pr:${url}`, at, turnId, kind: 'pullRequest', url, number: Number(m[1]), ...(pr.title ? { title: pr.title } : {}), action: 'linked' }));
					}
					break;
				}
				default:
					break;
			}
		});
		if (done) {
			closeMarkdown(parts.length);
			this.once(`end:${turnId}`, () => out.push({
				id: `end:${turnId}`, at: response.completedAt ?? Date.now(), turnId, kind: 'turnEnded',
				outcome: response.isCanceled ? 'cancelled' : response.result?.errorDetails ? 'failed' : 'completed',
				...(response.isCanceled ? { cancelledBy: 'user' as const } : {}),
				...(response.result?.errorDetails ? { reason: response.result.errorDetails.message } : {}),
			}));
			if (response.result?.errorDetails) {
				this.once(`err:${turnId}`, () => out.push({ id: `err:${turnId}`, at: response.completedAt ?? Date.now(), turnId, kind: 'error', message: response.result!.errorDetails!.message, ...(response.result!.errorDetails!.code ? { code: response.result!.errorDetails!.code } : {}) }));
			}
		}
	}

	private projectTool(part: IChatToolInvocation | IChatToolInvocationSerialized, turnId: string, out: IChatSessionEventInput[]): void {
		const callId = part.toolCallId;
		const nest = part.subAgentInvocationId ? { parentId: `sa:${part.subAgentInvocationId}` } : {};
		const started = (part.kind === 'toolInvocation' ? part.startedAt : undefined) ?? Date.now();
		const complete = IChatToolInvocation.isComplete(part);
		const data = part.toolSpecificData;
		if (!complete && IChatToolInvocation.isStreaming(part)) {
			return;
		}
		this.once(`call:${callId}`, () => {
			const params = IChatToolInvocation.getParameters(part);
			const input = params ?? (data?.kind === 'terminal' ? { command: isLegacyChatTerminalToolInvocationData(data) ? data.command : data.commandLine.toolEdited ?? data.commandLine.original } : data?.kind === 'simpleToolInvocation' ? data.input : text(part.invocationMessage));
			out.push({ id: `call:${callId}`, at: started, turnId, ...nest, kind: 'toolCall', callId, name: part.toolId, displayName: text(part.invocationMessage), input, ...(part.source ? { contributor: part.source.type } : {}) });
			if (data?.kind === 'subagent') {
				out.push({ id: `sa:${callId}`, at: started, turnId, kind: 'subagentStarted', name: data.agentDisplayName ?? data.agentName ?? 'subagent', ...(data.description ? { description: data.description } : {}), callId });
			}
		});
		if (!complete) {
			return;
		}
		this.once(`res:${callId}`, () => {
			const ended = (part.kind === 'toolInvocation' ? part.completedAt : undefined) ?? Date.now();
			const serialized = part.kind === 'toolInvocation' ? part.toJSON() : part;
			let output: string | undefined;
			let exitCode: number | undefined;
			let truncated = false;
			if (data?.kind === 'terminal' && !isLegacyChatTerminalToolInvocationData(data)) {
				output = data.terminalCommandOutput?.text;
				truncated = !!data.terminalCommandOutput?.truncated;
				exitCode = data.terminalCommandState?.exitCode;
			} else if (data?.kind === 'simpleToolInvocation') {
				output = data.output;
			} else if (data?.kind === 'todoList') {
				out.push({ id: `td:${callId}`, at: ended, turnId, ...nest, kind: 'todos', items: data.todoList.map(t => ({ id: t.id, title: t.title, status: t.status })) });
			}
			const details = serialized.resultDetails;
			if (output === undefined && details && !Array.isArray(details) && Array.isArray((details as { output?: unknown }).output) && typeof (details as { input?: unknown }).input === 'string') {
				output = (details as IToolResultInputOutputDetails).output.map(o => (o.type === 'embed' && o.isText !== false ? o.value : `[${o.mimeType ?? 'resource'}]`)).join('\n');
			} else if (output === undefined && Array.isArray(details)) {
				output = details.map(d => (URI.isUri(d) ? d.toString() : d.uri.toString())).join('\n');
			}
			if (output) {
				out.push({ id: `out:${callId}`, at: ended, turnId, ...nest, kind: 'toolOutput', callId, stream: 'content', text: output, totalChars: output.length, truncated });
			}
			const error = serialized.resultError;
			const cancelled = part.kind === 'toolInvocation' && part.state.get().type === IChatToolInvocation.StateKind.Cancelled;
			out.push({
				id: `res:${callId}`, at: ended, turnId, ...nest, kind: 'toolResult', callId,
				status: cancelled ? 'cancelled' : error ? 'failed' : 'completed', ...(exitCode !== undefined ? { exitCode } : {}),
				durationMs: Math.max(0, ended - started), ...(error ? { error: typeof error === 'string' ? error : 'error' } : {}),
			});
			if (data?.kind === 'subagent') {
				out.push({ id: `sae:${callId}`, at: ended, turnId, parentId: `sa:${callId}`, kind: 'subagentEnded', callId, status: data.isError ? 'failed' : 'completed' });
			}
		});
	}

	private projectPending(out: IChatSessionEventInput[]): void {
		const items = this.model.getPendingRequests().map(p => ({ id: p.request.id, kind: p.kind === 'steering' ? 'steering' as const : 'queued' as const, text: p.request.message.text, at: p.request.timestamp }));
		const key = JSON.stringify(items.map(i => [i.id, i.kind]));
		if (key !== this.lastPending) {
			this.lastPending = key;
			out.push({ id: `pending:${Date.now()}:${items.length}`, at: Date.now(), kind: 'pending', items });
		}
	}

	private projectTodos(out: IChatSessionEventInput[]): void {
		const items = this.todos();
		const key = JSON.stringify(items);
		if (items.length && key !== this.lastTodos) {
			this.lastTodos = key;
			out.push({ id: `todos:${Date.now()}`, at: Date.now(), kind: 'todos', items: items.map(t => ({ id: t.id, title: t.title, status: t.status })) });
		}
	}
}

export class ChatModelTranscriptSource extends Disposable implements IChatSessionTranscriptSource {
	readonly id = 'chatModel';
	readonly priority = 10;

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IChatTodoListService private readonly todoListService: IChatTodoListService,
	) {
		super();
	}

	canObserve(_resource: URI): boolean {
		return true;
	}

	async observe(resource: URI, sink: IChatSessionTranscriptSink): Promise<IDisposable> {
		const ref = await this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, CancellationToken.None, 'chatSessionObserver');
		if (!ref) {
			throw new Error(`No chat model for ${resource.toString()}`);
		}
		const store = new DisposableStore();
		store.add(ref);
		const model = ref.object;
		const projector = new ChatModelProjector(model, sink, () => this.todoListService.getTodos(resource).map(t => ({ id: String(t.id), title: t.title, status: t.status })));
		const scheduler = store.add(new RunOnceScheduler(() => projector.flush(), 150));
		const responses = store.add(new DisposableMap<string>());
		const watchResponses = () => {
			for (const r of model.getRequests()) {
				if (r.response && !responses.has(r.id)) {
					responses.set(r.id, r.response.onDidChange(() => scheduler.schedule()));
				}
			}
		};
		watchResponses();
		projector.flush();
		store.add(model.onDidChange(() => {
			watchResponses();
			scheduler.schedule();
		}));
		store.add(model.onDidChangePendingRequests(() => scheduler.schedule()));
		store.add(this.todoListService.onDidUpdateTodos(uri => {
			if (uri.toString() === resource.toString()) {
				scheduler.schedule();
			}
		}));
		sink.patchInfo({ fidelity: { reasoning: 'full', toolOutput: 'full', diffs: 'perTurn', timestamps: 'perTurn', modelCalls: false, liveWithoutWidget: true, liveLatencyMs: 150 } });
		return toDisposable(() => store.dispose());
	}
}
