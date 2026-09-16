/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/inboxOneView.css';
import { $, addDisposableListener, clearNode } from '../../../../base/browser/dom.js';
import { autorun, constObservable, IObservable, ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { buildConfirmation } from '../common/actionConfirmation.js';
import { IActionPayloads } from '../common/actionCatalog.js';
import { IInboxOneStore, TransitionOutcome } from '../common/inboxOneStore.js';
import { TaskTrigger } from '../common/inboxOneStateMachine.js';
import { ActionType, GestureKind, ILogicalTask, InboxOneTier, LogicalTaskState } from '../common/inboxOneTypes.js';
import { composeSteerRelay } from '../common/workerBrief.js';
import { IInboxOneSessionLauncher } from './inboxOneSessionLauncher.js';
import { IInboxOneNavigator } from './inboxOneNavigator.js';

interface ITierSpec {
	readonly key: string;
	readonly label: string;
	readonly match: (task: ILogicalTask) => boolean;
}

/** Sentinel selection value for the pinned Diffy coordinator entry. */
const DIFFY_SELECTION = '__diffy__';

/** Storage key for the persisted set of collapsed section keys. */
const COLLAPSED_SECTIONS_KEY = 'inboxOne.collapsedSections';

/** The inbox sections in display order (design 3.1). */
const SECTIONS: readonly ITierSpec[] = [
	{ key: 'critical', label: localize('inboxOne.critical', 'CRITICAL'), match: t => t.state === LogicalTaskState.Decision && t.tier === InboxOneTier.Critical },
	{ key: 'urgent', label: localize('inboxOne.urgent', 'URGENT'), match: t => (t.state === LogicalTaskState.Decision && t.tier === InboxOneTier.Urgent) || t.state === LogicalTaskState.Blocked },
	{ key: 'fyi', label: localize('inboxOne.fyi', 'FYI'), match: t => t.state === LogicalTaskState.Decision && (t.tier === InboxOneTier.Fyi || t.tier === undefined) },
	{ key: 'cooking', label: localize('inboxOne.cooking', 'COOKING'), match: t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming },
	{ key: 'completed', label: localize('inboxOne.completed', 'COMPLETED'), match: t => t.state === LogicalTaskState.Completed },
	{ key: 'archive', label: localize('inboxOne.archive', 'ARCHIVE'), match: t => t.state === LogicalTaskState.Archived },
];

/**
 * The tiered decisions inbox (design 3.1, wireframes 2). Two panes: the tiered
 * list on the left; the selected item's evidence pack on the right. Diffy is the
 * pinned first entry. Accept passes through a host-generated typed confirmation
 * (design 7.3, wireframes 16) before the transition runs.
 */
export class InboxOneView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('inboxOne.title', 'Inbox'));
	override readonly description: IObservable<string | undefined>;

	private readonly selectedTaskId: ISettableObservable<string | undefined> = observableValue('inboxOneSelected', undefined);
	/** The task whose inline steer/reopen composer is open in the detail pane, with the intent verb. */
	private readonly inlineCompose: ISettableObservable<{ readonly taskId: string; readonly intent: 'steer' | 'reopen' } | undefined> = observableValue('inboxOneInlineCompose', undefined);
	/** Draft text for the inline composer, kept off the observable so re-renders don't wipe it. */
	private inlineComposeDraft = '';
	private listEl: HTMLElement | undefined;
	private detailEl: HTMLElement | undefined;
	private confirmPanel: HTMLElement | undefined;
	/** A task whose list row should be scrolled into view on the next render (deep-link reveal). */
	private pendingScrollTaskId: string | undefined;
	/** Sections the user has collapsed (design/wireframes 6: the caret collapses a section). */
	private readonly collapsedSections = new Set<string>();
	/** The repo scope filter (wireframes 2 "my" selector); undefined = all repos. */
	private readonly scopeRepo: ISettableObservable<string | undefined> = observableValue('inboxOneScope', undefined);

	constructor(
		@IInboxOneStore private readonly store: IInboxOneStore,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IInboxOneSessionLauncher private readonly sessionLauncher: IInboxOneSessionLauncher,
		@IInboxOneNavigator private readonly navigator: IInboxOneNavigator,
	) {
		super();
		for (const key of this.loadCollapsedSections()) {
			this.collapsedSections.add(key);
		}
		// A notification (or any caller) can ask us to open + focus a specific item.
		this._register(this.navigator.onDidRequestReveal(() => {
			const taskId = this.navigator.consumePendingReveal();
			if (taskId) {
				this.selectAndReveal(taskId);
			}
		}));
		this.description = this.store.tasks.map(tasks => {
			const cooking = tasks.filter(t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming).length;
			const decisions = tasks.filter(t => t.state === LogicalTaskState.Decision || t.state === LogicalTaskState.Blocked).length;
			return localize('inboxOne.desc', 'Diffy - {0} need you, {1} cooking', decisions, cooking);
		});
	}

	private loadCollapsedSections(): readonly string[] {
		try {
			const raw = this.storageService.get(COLLAPSED_SECTIONS_KEY, StorageScope.APPLICATION);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
		} catch {
			return [];
		}
	}

	private persistCollapsedSections(): void {
		this.storageService.store(COLLAPSED_SECTIONS_KEY, JSON.stringify([...this.collapsedSections]), StorageScope.APPLICATION, StorageTarget.USER);
	}

	render(container: HTMLElement): void {
		container.classList.add('inbox-one-view');
		// The shared custom-view host is tabindex=-1 and shows a focus-fallback
		// outline when a click lands on a non-focusable row. This view manages its
		// own selection highlight, so suppress that outline robustly via an inline
		// !important rule (beats the shared stylesheet regardless of load order).
		container.style.setProperty('outline', 'none', 'important');
		const panes = container.appendChild($('.inbox-one-panes'));

		const left = panes.appendChild($('.inbox-one-left'));
		const diffy = left.appendChild($('.inbox-one-diffy'));
		diffy.appendChild($('.inbox-one-diffy-badge', undefined, '\u2726'));
		diffy.appendChild($('.inbox-one-diffy-label', undefined, localize('inboxOne.diffy', 'Diffy')));
		this._register(addClick(diffy, () => this.selectedTaskId.set(DIFFY_SELECTION, undefined)));
		this._register(autorun(reader => {
			diffy.classList.toggle('selected', this.selectedTaskId.read(reader) === DIFFY_SELECTION);
		}));
		const scopeEl = left.appendChild($('.inbox-one-scope'));
		this.listEl = left.appendChild($('.inbox-one-list'));

		this.detailEl = panes.appendChild($('.inbox-one-detail'));

		this._register(autorun(reader => {
			const tasks = this.store.tasks.read(reader);
			const selected = this.selectedTaskId.read(reader);
			const scope = this.scopeRepo.read(reader);
			this.inlineCompose.read(reader);
			this.renderScope(scopeEl, tasks, scope);
			const scoped = scope ? tasks.filter(t => t.repo === scope) : tasks;
			this.renderList(scoped, selected);
			if (selected === DIFFY_SELECTION) {
				this.renderDiffyDetail(tasks);
			} else {
				this.renderDetail(tasks.find(t => t.id === selected));
			}
		}));

		// Apply a reveal requested before this view rendered (e.g. a notification's
		// "Open" that created the view), so it focuses the linked item on first show.
		const pending = this.navigator.consumePendingReveal();
		if (pending) {
			this.selectAndReveal(pending);
		}
	}

	/**
	 * Opens and focuses a specific task: expands its (possibly collapsed) section,
	 * selects it so its evidence shows on the right, and scrolls the row into view.
	 * Used by the notification "Open" deep-link.
	 */
	private selectAndReveal(taskId: string): void {
		const task = this.store.getTask(taskId);
		if (task) {
			const section = SECTIONS.find(s => s.match(task));
			if (section && this.collapsedSections.has(section.key)) {
				this.collapsedSections.delete(section.key);
				this.persistCollapsedSections();
			}
		}
		this.pendingScrollTaskId = taskId;
		this.selectedTaskId.set(taskId, undefined);
	}

	/** The "my" repo scope selector (wireframes 2): scope the inbox to one enrolled repo or all. */
	private renderScope(container: HTMLElement, tasks: readonly ILogicalTask[], scope: string | undefined): void {
		clearNode(container);
		const repos = Array.from(new Set(tasks.map(t => t.repo).filter((r): r is string => !!r))).sort();
		if (repos.length < 2) {
			container.style.display = 'none';
			return;
		}
		container.style.display = '';
		container.appendChild($('span.inbox-one-scope-label', undefined, localize('inboxOne.scopeLabel', 'Showing')));
		const select = container.appendChild($('select.inbox-one-scope-select')) as HTMLSelectElement;
		const allOpt = select.appendChild($('option')) as HTMLOptionElement;
		allOpt.value = '';
		allOpt.textContent = localize('inboxOne.scopeAll', 'all repos');
		allOpt.selected = !scope;
		for (const repo of repos) {
			const opt = select.appendChild($('option')) as HTMLOptionElement;
			opt.value = repo;
			opt.textContent = repo;
			opt.selected = scope === repo;
		}
		this._register(addDisposableListener(select, 'change', () => {
			this.scopeRepo.set(select.value || undefined, undefined);
		}));
	}

	/** The Diffy coordinator thread (design 3.2): watching status, on-demand brief, composer. */
	private renderDiffyDetail(tasks: readonly ILogicalTask[]): void {
		const detail = this.detailEl;
		if (!detail) {
			return;
		}
		clearNode(detail);
		this.confirmPanel = undefined;

		const repos = new Set(tasks.map(t => t.repo).filter(Boolean));
		detail.appendChild($('.inbox-one-detail-tier', undefined, localize('inboxOne.coordinator', 'COORDINATOR')));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, localize('inboxOne.diffyWatching', 'Diffy - watching {0} repo(s)', repos.size)));

		const decisions = tasks.filter(t => t.state === LogicalTaskState.Decision || t.state === LogicalTaskState.Blocked);
		const cooking = tasks.filter(t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming);
		const autoHandled = tasks.filter(t => t.tier === InboxOneTier.Fyi && t.state === LogicalTaskState.Completed);

		const brief = detail.appendChild($('.inbox-one-diffy-brief'));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefNeed', '{0} need you', decisions.length)));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefCooking', '{0} cooking', cooking.length)));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefAuto', '{0} auto-handled and logged', autoHandled.length)));

		const settingsLink = brief.appendChild($('a.inbox-one-claim-receipt', undefined, localize('inboxOne.openSettings', 'Coordinator settings')));
		this._register(addClick(settingsLink, () => void this.commandService.executeCommand('inboxOne.showSettings')));
		brief.appendChild($('span', undefined, '  '));
		const skillsLink = brief.appendChild($('a.inbox-one-claim-receipt', undefined, localize('inboxOne.openSkills', 'Skills & roles')));
		this._register(addClick(skillsLink, () => void this.commandService.executeCommand('inboxOne.showSkills')));

		const composer = detail.appendChild($('.inbox-one-diffy-composer-wrap'));
		const composerRow = composer.appendChild($('.inbox-one-diffy-composer'));
		const input = composerRow.appendChild($('input.inbox-one-diffy-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('inboxOne.talkToDiffy', 'Talk to Diffy...');
		const send = composerRow.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, localize('inboxOne.send', 'Send')));
		const submit = () => {
			const text = input.value.trim();
			if (!text) {
				return;
			}
			input.value = '';
			this.notificationService.info(localize('inboxOne.diffyReply', 'Diffy: {0}', this.diffyReply(text, decisions.length, cooking.length, repos.size)));
		};
		this._register(addClick(send, submit));
		this._register(addKeydown(input, 'Enter', submit));
	}

	/** The reference-into-Diffy continuation (design 3.6, 2.4): steer/reopen -> relay the
	 * user's instruction into the warm worker session and re-open the task (same session). */
	private async continueTask(task: ILogicalTask, intent: 'steer' | 'reopen', message: string): Promise<void> {
		const continuationKey = `${task.id}:${intent}:${Date.now()}`;
		const trigger = intent === 'reopen' ? TaskTrigger.Reopen : TaskTrigger.Steer;
		// Record the user's steering/correction verbatim as a gesture, so the full
		// steering history (not just the gesture kind) reaches the distiller when the
		// task later resolves (design 6.2). Reopen is a steer on a completed result.
		void this.store.recordGesture({ taskId: task.id, kind: GestureKind.Steer, note: message, timestamp: Date.now() });
		// Diffy relays the instruction into the SAME worker session (warm context,
		// technical spec 2.4). Carry the ref into the new attempt so the session
		// stays owned by the task (Open works, and its next finish re-lands here).
		const ref = task.attempts[task.currentAttempt]?.sessionRef;
		const relayable = !!ref && !ref.startsWith('inboxone-pending:') && !ref.startsWith('inboxone-stub:');
		// Relay the user's instruction plus an explicit "emit a fresh result" reminder,
		// so the worker always re-emits an updated card instead of answering in prose
		// (which would leave the stale previous block to be re-landed).
		const relayed = relayable ? await this.sessionLauncher.relay(ref!, composeSteerRelay(message)) : false;
		const res = await this.store.openContinuation(task.id, trigger, continuationKey, undefined, relayed ? { attemptSessionRef: ref } : undefined);
		if (res.outcome === TransitionOutcome.Applied && !res.fencedNoop) {
			this.selectedTaskId.set(task.id, undefined);
			this.notificationService.info(!relayed
				? localize('inboxOne.continuedNoWorker', 'Diffy re-opened this - now Cooking. (No live worker session to relay into; it will re-dispatch.)')
				: intent === 'reopen'
					? localize('inboxOne.reopened', 'Diffy reopened this and sent the worker your note - now Cooking.')
					: localize('inboxOne.steered', 'Diffy sent your steer to the worker - now Cooking.'));
		} else {
			this.notificationService.warn(localize('inboxOne.continueFailed', 'Could not continue this task from its current state.'));
		}
	}

	private diffyReply(prompt: string, needYou: number, cooking: number, repos: number): string {
		const lower = prompt.toLowerCase();
		if (lower.includes('brief') || lower.includes('status')) {
			return localize('inboxOne.diffyBrief', 'Across {0} repo(s): {1} need you, {2} cooking. Nothing else cleared the bar.', repos, needYou, cooking);
		}
		return localize('inboxOne.diffyAck', "Got it. I'll factor that into how I triage and dispatch.");
	}

	private renderList(tasks: readonly ILogicalTask[], selectedId: string | undefined): void {
		const list = this.listEl;
		if (!list) {
			return;
		}
		clearNode(list);

		if (tasks.length === 0) {
			const empty = list.appendChild($('.inbox-one-empty'));
			empty.appendChild($('.inbox-one-empty-title', undefined, localize('inboxOne.allClear', "You're all clear.")));
			empty.appendChild($('.inbox-one-empty-sub', undefined, localize('inboxOne.watching', 'Diffy is watching; new decisions land here.')));
			return;
		}

		for (const section of SECTIONS) {
			const items = tasks.filter(section.match);
			if (items.length === 0) {
				continue;
			}
			const collapsed = this.collapsedSections.has(section.key);
			const header = list.appendChild($('button.inbox-one-section-header'));
			header.classList.toggle('collapsed', collapsed);
			header.appendChild($('span.inbox-one-section-caret', undefined, collapsed ? '\u203a' : '\u2304'));
			header.appendChild($('.inbox-one-section-label', undefined, section.label));
			header.appendChild($('.inbox-one-section-count', undefined, String(items.length)));
			this._register(addClick(header, () => {
				if (this.collapsedSections.has(section.key)) {
					this.collapsedSections.delete(section.key);
				} else {
					this.collapsedSections.add(section.key);
				}
				this.persistCollapsedSections();
				this.renderList(this.store.tasks.get(), this.selectedTaskId.get());
			}));
			if (collapsed) {
				continue;
			}
			for (const task of items) {
				list.appendChild(this.renderListItem(task, section.key, task.id === selectedId));
			}
		}
	}

	private renderListItem(task: ILogicalTask, sectionKey: string, selected: boolean): HTMLElement {
		const row = $('.inbox-one-item');
		row.classList.add(`inbox-one-item-${sectionKey}`);
		if (selected) {
			row.classList.add('selected');
		}
		const blocked = task.state === LogicalTaskState.Blocked;
		if (blocked) {
			row.classList.add('blocked');
		}
		const title = row.appendChild($('.inbox-one-item-title'));
		if (blocked) {
			title.appendChild($('span.inbox-one-item-blocked-badge', undefined, localize('inboxOne.blockedBadge', '! BLOCKED')));
		}
		title.appendChild($('span', undefined, this.listTitle(task)));
		const meta = row.appendChild($('.inbox-one-item-meta'));
		if (task.repo) {
			meta.appendChild($('span.inbox-one-item-repo', undefined, task.repo));
		}
		meta.appendChild($('span.inbox-one-item-reason', undefined, task.rankReason ?? this.stateLabel(task.state)));
		if (task.state === LogicalTaskState.Cooking || task.state === LogicalTaskState.Confirming) {
			row.appendChild(this.renderCookingStages(task, true));
		}
		this._register(addClick(row, () => this.selectedTaskId.set(task.id, undefined)));
		if (this.pendingScrollTaskId === task.id) {
			this.pendingScrollTaskId = undefined;
			queueMicrotask(() => row.scrollIntoView({ block: 'nearest' }));
		}
		return row;
	}

	private renderDetail(task: ILogicalTask | undefined): void {
		const detail = this.detailEl;
		if (!detail) {
			return;
		}
		clearNode(detail);

		if (!task) {
			detail.appendChild($('.inbox-one-detail-empty', undefined, localize('inboxOne.selectItem', 'Select an item to see its evidence.')));
			return;
		}

		if (task.state === LogicalTaskState.Blocked) {
			this.renderBlockedDetail(detail, task);
			return;
		}

		const pack = task.evidence;
		detail.appendChild($('.inbox-one-detail-tier', undefined, `${(task.tier ?? '').toUpperCase()} - ${task.type}`));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, this.listTitle(task)));
		if (pack?.decisionSentence) {
			detail.appendChild($('.inbox-one-detail-summary', undefined, pack.decisionSentence));
		}
		if (task.repo) {
			detail.appendChild($('.inbox-one-detail-sub', undefined, `${task.repo}${pack?.freshness.headSha ? ' - head ' + pack.freshness.headSha : ''}`));
		}

		if (pack?.primaryAction) {
			detail.appendChild($('.inbox-one-detail-accepting', undefined, this.acceptingLine(pack.primaryAction.actionType)));
		}

		if (pack?.customAsk) {
			const ask = detail.appendChild($('.inbox-one-detail-ask'));
			ask.appendChild($('.inbox-one-detail-ask-label', undefined, localize('inboxOne.diffyAsks', 'Diffy needs your decision:')));
			ask.appendChild($('.inbox-one-detail-ask-body', undefined, pack.customAsk));
		}

		if (pack && pack.claims.length) {
			const why = detail.appendChild($('.inbox-one-detail-claims'));
			why.appendChild($('.inbox-one-detail-claims-header', undefined, localize('inboxOne.evidence', 'Evidence')));
			for (const claim of pack.claims) {
				const claimEl = why.appendChild($('.inbox-one-claim'));
				claimEl.appendChild($('span.inbox-one-claim-bullet', undefined, '\u2022'));
				claimEl.appendChild($('span.inbox-one-claim-text', undefined, claim.text));
				if (claim.receiptLink) {
					const link = claimEl.appendChild($('a.inbox-one-claim-receipt', undefined, localize('inboxOne.receipt', 'receipt')));
					this._register(addClick(link, () => this.openReceipt(claim.receiptLink!)));
				}
			}
		}

		if (pack?.gapLine) {
			detail.appendChild($('.inbox-one-detail-gap', undefined, pack.gapLine));
		}

		if (task.state === LogicalTaskState.Decision) {
			detail.appendChild(this.renderDetailActions(task));
		} else if (task.state === LogicalTaskState.Completed) {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.completedNote', 'Completed. History preserved.')));
			const actions = detail.appendChild($('.inbox-one-detail-actions'));
			const reopen = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, localize('inboxOne.reopen', 'Reopen with Diffy')));
			this._register(addClick(reopen, () => this.openInlineComposer(task, 'reopen')));
			const open = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.openWork', 'Open')));
			this._register(addClick(open, () => this.openWorkerSession(task)));
			const archive = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.archiveBtn', 'Archive')));
			this._register(addClick(archive, () => this.dismiss(task)));
		} else if (task.state === LogicalTaskState.Archived) {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.archivedNote', 'Archived. History preserved.')));
			const actions = detail.appendChild($('.inbox-one-detail-actions'));
			const restore = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, `${localize('inboxOne.restore', 'Restore')} \u25b8`));
			this._register(addClick(restore, () => this.restore(task)));
			const open = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.openWork', 'Open')));
			this._register(addClick(open, () => this.openWorkerSession(task)));
			const del = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.deleteBtn', 'Delete')));
			this._register(addClick(del, () => this.deleteTask(task)));
		} else if (task.state === LogicalTaskState.Cooking || task.state === LogicalTaskState.Confirming) {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.cookingNote', 'Diffy is working on this. Evidence will land here when ready.')));
			const actions = detail.appendChild($('.inbox-one-detail-actions'));
			const open = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.openWork', 'Open')));
			this._register(addClick(open, () => this.openWorkerSession(task)));
			const cancel = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.cancelWork', 'Cancel work')));
			this._register(addClick(cancel, () => this.cancelWork(task)));
		}

		this.renderInlineComposer(detail, task);
	}

	/**
	 * The inline steer/reopen composer (design 3.4/3.6): opened in place under the item's
	 * actions when the user clicks Steer or Reopen, so the item's evidence stays in view.
	 * Diffy still mediates - `continueTask` relays the note into the warm worker session.
	 */
	private renderInlineComposer(detail: HTMLElement, task: ILogicalTask): void {
		const open = this.inlineCompose.get();
		if (!open || open.taskId !== task.id) {
			return;
		}
		const wrap = detail.appendChild($('.inbox-one-steer-inline'));
		const input = wrap.appendChild($('input.inbox-one-diffy-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = open.intent === 'reopen'
			? localize('inboxOne.reopenPrompt', 'Reopen this and ...')
			: localize('inboxOne.steerPrompt', "Here's how you can make it better...");
		input.value = this.inlineComposeDraft;
		this._register(addDisposableListener(input, 'input', () => { this.inlineComposeDraft = input.value; }));
		const send = wrap.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, localize('inboxOne.send', 'Send')));
		const submit = () => {
			const text = input.value.trim();
			if (!text) {
				return;
			}
			this.inlineComposeDraft = '';
			this.inlineCompose.set(undefined, undefined);
			void this.continueTask(task, open.intent, text);
		};
		this._register(addClick(send, submit));
		this._register(addKeydown(input, 'Enter', submit));
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}

	/**
	 * The Blocked recovery layout (wireframes 7): a distinct "! BLOCKED" header,
	 * what is blocked, and the single recovery step, with a primary action that
	 * supplies the fact/permission (-> back to Cooking), plus Steer and Dismiss.
	 */
	private renderBlockedDetail(detail: HTMLElement, task: ILogicalTask): void {
		const pack = task.evidence;
		const subject = task.sourceEvent.subject;
		detail.appendChild($('.inbox-one-detail-blocked-tier', undefined, `\u0021 ${localize('inboxOne.blockedLabel', 'BLOCKED')} \u00b7 ${task.type}`));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, this.listTitle(task)));
		if (pack?.decisionSentence) {
			detail.appendChild($('.inbox-one-detail-summary', undefined, pack.decisionSentence));
		}
		detail.appendChild($('.inbox-one-detail-sub', undefined, `${task.repo ?? ''}${task.repo ? ' \u00b7 ' : ''}${subject.kind} ${subject.id}`));

		const need = detail.appendChild($('.inbox-one-blocked-need'));
		need.appendChild($('span.inbox-one-blocked-need-label', undefined, localize('inboxOne.whatINeed', 'What I need: ')));
		need.appendChild($('span', undefined, task.recoveryStep ?? localize('inboxOne.blockedGeneric', 'a human-only fact or permission to continue.')));

		const actions = detail.appendChild($('.inbox-one-detail-actions'));
		const supply = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, `${localize('inboxOne.provideAndRetry', "I've unblocked this")} \u25b8`));
		this._register(addClick(supply, () => this.recoverySupplied(task)));
		const steer = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.steer', 'Steer')));
		this._register(addClick(steer, () => this.steer(task)));
		const dismiss = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.dismiss', 'Dismiss')));
		this._register(addClick(dismiss, () => this.dismiss(task)));

		this.renderInlineComposer(detail, task);
	}

	/** Human supplied the blocker's fact/permission: retry (Blocked -> Cooking). */
	private async recoverySupplied(task: ILogicalTask): Promise<void> {
		const res = await this.store.transition(task.id, TaskTrigger.RecoverySupplied);
		if (res.task) {
			this.notificationService.info(localize('inboxOne.unblocked', "Thanks - I'll retry now with that unblocked."));
		}
	}

	/**
	 * The three cooking stages (wireframes 6): Triggered -> Doing work ->
	 * Assembling evidence. Shown in the left list preview; `compact` drops the
	 * role/elapsed meta line for the tighter row layout.
	 */
	private renderCookingStages(task: ILogicalTask, compact = false): HTMLElement {
		const wrap = $('.inbox-one-cooking');
		if (compact) {
			wrap.classList.add('compact');
		}
		const active = task.state === LogicalTaskState.Confirming ? 2 : 1;
		const labels = [
			localize('inboxOne.stageTriggered', 'Triggered'),
			localize('inboxOne.stageDoing', 'Doing work'),
			localize('inboxOne.stageAssembling', 'Assembling evidence'),
		];
		const stages = wrap.appendChild($('.inbox-one-cooking-stages'));
		labels.forEach((label, i) => {
			if (i > 0) {
				stages.appendChild($(`.inbox-one-cooking-rail${i <= active ? '.filled' : ''}`));
			}
			const state = i < active ? 'done' : i === active ? 'active' : 'pending';
			const stage = stages.appendChild($(`.inbox-one-cooking-stage.${state}`));
			stage.appendChild($('span.inbox-one-cooking-dot', undefined, state === 'pending' ? '\u25cb' : '\u25cf'));
			stage.appendChild($('span', undefined, label));
		});
		if (!compact) {
			const attempt = task.attempts[task.currentAttempt];
			const elapsed = formatElapsed(Date.now() - (attempt?.startedAt ?? task.createdAt));
			wrap.appendChild($('.inbox-one-cooking-meta', undefined, `\u25b2 ${task.type} \u00b7 ${elapsed}`));
		}
		return wrap;
	}

	/** Opens the live worker session backing the current attempt (wireframes 6: [ Open ]). */
	private openWorkerSession(task: ILogicalTask): void {
		const ref = task.attempts[task.currentAttempt]?.sessionRef;
		if (!ref || ref.startsWith('inboxone-pending:') || ref.startsWith('inboxone-stub:')) {
			this.notificationService.info(localize('inboxOne.noWorkerYet', "No worker session is available to open yet. If no workspace can host a session here, open one as you would for a New Session and re-run."));
			return;
		}
		let uri: URI;
		try {
			uri = URI.parse(ref);
		} catch {
			this.notificationService.info(localize('inboxOne.openFailed', "Could not open the worker session."));
			return;
		}
		// Navigate to the session through the sessions service (the same primitive
		// clicking a session in the list uses), not a generic URI open.
		void this.sessionsService.openSession(uri).catch(() => {
			this.notificationService.info(localize('inboxOne.openFailed', "Could not open the worker session."));
		});
	}

	/** Steer (design 3.4): item-initiated -> open an inline composer under the item's actions,
	 * so the user keeps the item's evidence in view while writing the steer. */
	private steer(task: ILogicalTask): void {
		this.openInlineComposer(task, 'steer');
	}

	/** Opens (or toggles closed) the inline steer/reopen composer for this item in place,
	 * without leaving the item's detail. Diffy still mediates the relay in `continueTask`. */
	private openInlineComposer(task: ILogicalTask, intent: 'steer' | 'reopen'): void {
		const open = this.inlineCompose.get();
		if (open && open.taskId === task.id && open.intent === intent) {
			this.inlineCompose.set(undefined, undefined);
			return;
		}
		this.inlineComposeDraft = '';
		this.selectedTaskId.set(task.id, undefined);
		this.inlineCompose.set({ taskId: task.id, intent }, undefined);
	}

	private async cancelWork(task: ILogicalTask): Promise<void> {
		await this.store.transition(task.id, TaskTrigger.CancelWork, { archiveReason: 'cancelled from inbox' });
	}

	/** Restore an archived task to its prior tier (Archived -> Decision). */
	private async restore(task: ILogicalTask): Promise<void> {
		await this.store.transition(task.id, TaskTrigger.Restore);
	}

	/** Permanently remove an archived task (Archived -> removed). */
	private async deleteTask(task: ILogicalTask): Promise<void> {
		await this.store.transition(task.id, TaskTrigger.Delete);
	}

	private renderDetailActions(task: ILogicalTask): HTMLElement {
		const actions = $('.inbox-one-detail-actions');
		// A custom ask ("other" action) has no typed action to accept; the human
		// answers the worker's ask via Steer, so Steer is the primary affordance.
		if (task.evidence?.customAsk) {
			const steerPrimary = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, `${localize('inboxOne.steer', 'Steer')} \u25b8`));
			this._register(addClick(steerPrimary, () => this.steer(task)));
			const dismiss = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.dismiss', 'Dismiss')));
			this._register(addClick(dismiss, () => this.dismiss(task)));
			return actions;
		}
		const primaryLabel = task.evidence?.primaryAction?.label ?? localize('inboxOne.accept', 'Accept');
		const accept = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, `${primaryLabel} \u25b8`));
		this._register(addClick(accept, () => this.confirmAndAccept(task)));

		const steer = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.steer', 'Steer')));
		this._register(addClick(steer, () => this.steer(task)));

		const dismiss = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.dismiss', 'Dismiss')));
		this._register(addClick(dismiss, () => this.dismiss(task)));
		return actions;
	}

	/** Renders the host-generated typed confirmation inline, then executes on confirm (design 7.3). */
	private confirmAndAccept(task: ILogicalTask): void {
		const detail = this.detailEl;
		const action = task.evidence?.primaryAction;
		if (!detail || !action) {
			void this.accept(task);
			return;
		}
		this.confirmPanel?.remove();
		const confirmation = buildConfirmation(action.actionType, action.payload as IActionPayloads[typeof action.actionType]);
		const panel = detail.appendChild($('.inbox-one-confirm'));
		this.confirmPanel = panel;
		if (confirmation.highlight) {
			panel.classList.add('irreversible');
		}
		panel.appendChild($('.inbox-one-confirm-title', undefined, localize('inboxOne.confirmTitle', 'Confirm - {0}', action.label)));
		const effects = panel.appendChild($('.inbox-one-confirm-effects'));
		effects.appendChild($('.inbox-one-confirm-effects-label', undefined, localize('inboxOne.thisWill', 'This will:')));
		for (const line of confirmation.effectLines) {
			effects.appendChild($('.inbox-one-confirm-effect', undefined, `\u2022 ${line}`));
		}
		panel.appendChild($('.inbox-one-confirm-reversibility', undefined, confirmation.reversibilityLine));
		if (task.evidence?.gapLine) {
			panel.appendChild($('.inbox-one-confirm-gap', undefined, task.evidence.gapLine));
		}
		const buttons = panel.appendChild($('.inbox-one-confirm-buttons'));
		const cancel = buttons.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.cancel', 'Cancel')));
		this._register(addClick(cancel, () => panel.remove()));
		const go = buttons.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, action.label));
		this._register(addClick(go, () => { panel.remove(); void this.accept(task); }));
	}

	private acceptingLine(actionType: ActionType): string {
		switch (actionType) {
			case ActionType.ApprovePr: return localize('inboxOne.acceptingApprove', 'Accepting: approves the PR (you still control the merge).');
			case ActionType.MergePr: return localize('inboxOne.acceptingMerge', 'Accepting: merges the PR and reruns checks.');
			case ActionType.CreateIssues: return localize('inboxOne.acceptingIssues', 'Accepting: creates the grouped meta-issues.');
			default: return localize('inboxOne.acceptingGeneric', 'Accepting runs the typed action.');
		}
	}

	private async accept(task: ILogicalTask): Promise<void> {
		const attemptIndex = task.attempts[task.currentAttempt]?.index ?? 0;
		const revision = task.evidence?.revision;
		const res = await this.store.transition(task.id, TaskTrigger.Accept, undefined, { expected: { attemptIndex, evidenceRevision: revision } });
		if (res.task) {
			await this.store.transition(task.id, TaskTrigger.ConfirmSucceeded);
			this.notificationService.info(localize('inboxOne.accepted', 'Accepted: {0}', task.evidence?.primaryAction?.label ?? task.type));
		} else {
			this.notificationService.warn(localize('inboxOne.staleAccept', 'This decision changed - re-verify before accepting.'));
		}
	}

	private async dismiss(task: ILogicalTask): Promise<void> {
		await this.store.transition(task.id, TaskTrigger.Dismiss, { archiveReason: 'dismissed from inbox' });
	}

	private openReceipt(link: string): void {
		try {
			this.openerService.open(URI.parse(link));
		} catch {
			this.notificationService.info(localize('inboxOne.receiptLink', 'Receipt: {0}', link));
		}
	}

	private fallbackTitle(task: ILogicalTask): string {
		const subject = task.sourceEvent.subject;
		return localize('inboxOne.itemTitle', '{0} {1} ({2})', task.type, subject.kind, subject.id);
	}

	/**
	 * The inbox list title: the worker-authored, self-contained headline when
	 * present, else the generic subject fallback. We never derive it by truncating
	 * decisionSentence -- a prefix of the recommendation is not a real title.
	 */
	private listTitle(task: ILogicalTask): string {
		return task.evidence?.title?.trim() || this.fallbackTitle(task);
	}

	private stateLabel(state: LogicalTaskState): string {
		switch (state) {
			case LogicalTaskState.Cooking: return localize('inboxOne.stateCooking', 'cooking');
			case LogicalTaskState.Confirming: return localize('inboxOne.stateConfirming', 'confirming');
			case LogicalTaskState.Completed: return localize('inboxOne.stateCompleted', 'completed');
			case LogicalTaskState.Archived: return localize('inboxOne.stateArchived', 'archived');
			default: return '';
		}
	}

	layout(_width: number, _height: number): void { }
}

function addClick(el: HTMLElement, handler: () => void): { dispose(): void } {
	const listener = (e: Event) => { e.preventDefault(); e.stopPropagation(); handler(); };
	el.addEventListener('click', listener);
	return { dispose: () => el.removeEventListener('click', listener) };
}

/** Human-legible elapsed time (no telemetry chrome): "just now", "6m", "2h". */
function formatElapsed(ms: number): string {
	const mins = Math.floor(ms / 60000);
	if (mins < 1) { return localize('inboxOne.justNow', 'just now'); }
	if (mins < 60) { return localize('inboxOne.minutes', '{0}m', mins); }
	return localize('inboxOne.hours', '{0}h', Math.floor(mins / 60));
}

function addKeydown(el: HTMLElement, key: string, handler: () => void): { dispose(): void } {
	const listener = (e: KeyboardEvent) => { if (e.key === key) { e.preventDefault(); handler(); } };
	el.addEventListener('keydown', listener);
	return { dispose: () => el.removeEventListener('keydown', listener) };
}
