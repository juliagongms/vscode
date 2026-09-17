/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/inboxOneView.css';
import { $, addDisposableListener, clearNode } from '../../../../base/browser/dom.js';
import { autorun, constObservable, IObservable, ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { buildConfirmation } from '../common/actionConfirmation.js';
import { IActionPayloads } from '../common/actionCatalog.js';
import { IInboxOneStore, TransitionOutcome } from '../common/inboxOneStore.js';
import { TaskTrigger } from '../common/inboxOneStateMachine.js';
import { ActionType, GestureKind, IEvidenceClaim, ILogicalTask, InboxOneTier, IPrimaryAction, LogicalTaskState } from '../common/inboxOneTypes.js';
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

/** The inbox sections in display order. Attention states (design 3.1, refined UX). */
const SECTIONS: readonly ITierSpec[] = [
	{ key: 'attention', label: localize('inboxOne.needsAttention', 'Needs attention'), match: t => t.state === LogicalTaskState.Decision || t.state === LogicalTaskState.Blocked },
	{ key: 'in-progress', label: localize('inboxOne.inProgress', 'In progress'), match: t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming },
	{ key: 'complete', label: localize('inboxOne.complete', 'Complete'), match: t => t.state === LogicalTaskState.Completed },
	{ key: 'archive', label: localize('inboxOne.archive', 'Archive'), match: t => t.state === LogicalTaskState.Archived },
];

/** Priority of a task within the merged "Needs attention" group (lower sorts first). */
function attentionPriority(task: ILogicalTask): number {
	if (task.state === LogicalTaskState.Blocked) { return 0; }
	switch (task.tier) {
		case InboxOneTier.Critical: return 1;
		case InboxOneTier.Urgent: return 2;
		default: return 3;
	}
}

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
	/** A task whose list row should be scrolled into view on the next render (deep-link reveal). */
	private pendingScrollTaskId: string | undefined;
	/** Sections the user has collapsed (design/wireframes 6: the caret collapses a section). */
	private readonly collapsedSections = new Set<string>();
	/** The repo scope filter (wireframes 2 "my" selector); undefined = all repos. */
	private readonly scopeRepo: ISettableObservable<string | undefined> = observableValue('inboxOneScope', undefined);
	/** Free-text filter over the list (refined UX: filter tasks for larger inboxes). */
	private readonly searchQuery: ISettableObservable<string> = observableValue('inboxOneSearch', '');

	constructor(
		@IInboxOneStore private readonly store: IInboxOneStore,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
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
			return localize('inboxOne.desc', 'Diffy - {0} need you, {1} in progress', decisions, cooking);
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
		const searchWrap = left.appendChild($('.inbox-one-search'));
		const searchInput = searchWrap.appendChild($('input.inbox-one-search-input')) as HTMLInputElement;
		searchInput.type = 'search';
		searchInput.placeholder = localize('inboxOne.filterTasks', 'Filter tasks');
		searchInput.setAttribute('aria-label', localize('inboxOne.filterTasks', 'Filter tasks'));
		this._register(addDisposableListener(searchInput, 'input', () => this.searchQuery.set(searchInput.value, undefined)));
		this.listEl = left.appendChild($('.inbox-one-list'));

		this.detailEl = panes.appendChild($('.inbox-one-detail'));

		this._register(autorun(reader => {
			const tasks = this.store.tasks.read(reader);
			const selected = this.selectedTaskId.read(reader);
			const scope = this.scopeRepo.read(reader);
			const query = this.searchQuery.read(reader).trim().toLowerCase();
			this.inlineCompose.read(reader);
			this.renderScope(scopeEl, tasks, scope);
			const scoped = scope ? tasks.filter(t => t.repo === scope) : tasks;
			const filtered = query ? scoped.filter(t => this.matchesQuery(t, query)) : scoped;
			this.renderList(filtered, selected);
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

		const repos = new Set(tasks.map(t => t.repo).filter(Boolean));
		detail.appendChild($('.inbox-one-detail-tier', undefined, localize('inboxOne.coordinator', 'COORDINATOR')));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, localize('inboxOne.diffyWatching', 'Diffy - watching {0} repo(s)', repos.size)));

		const decisions = tasks.filter(t => t.state === LogicalTaskState.Decision || t.state === LogicalTaskState.Blocked);
		const cooking = tasks.filter(t => t.state === LogicalTaskState.Cooking || t.state === LogicalTaskState.Confirming);
		const autoHandled = tasks.filter(t => t.tier === InboxOneTier.Fyi && t.state === LogicalTaskState.Completed);

		const brief = detail.appendChild($('.inbox-one-diffy-brief'));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefNeed', '{0} need you', decisions.length)));
		brief.appendChild($('.inbox-one-diffy-brief-line', undefined, localize('inboxOne.briefCooking', '{0} in progress', cooking.length)));
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
			return localize('inboxOne.diffyBrief', 'Across {0} repo(s): {1} need you, {2} in progress. Nothing else cleared the bar.', repos, needYou, cooking);
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
			// The "Needs attention" group merges the decision tiers, so sort it by
			// priority (blocked, then critical/urgent/fyi), then rank, so the most
			// pressing item still leads.
			if (section.key === 'attention') {
				items.sort((a, b) => attentionPriority(a) - attentionPriority(b) || (b.rank ?? 0) - (a.rank ?? 0));
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
		if (task.state === LogicalTaskState.Decision && task.tier === InboxOneTier.Critical) {
			row.classList.add('inbox-one-item-critical');
		}
		if (selected) {
			row.classList.add('selected');
		}
		const blocked = task.state === LogicalTaskState.Blocked;
		if (blocked) {
			row.classList.add('blocked');
		}
		const title = row.appendChild($('.inbox-one-item-title'));
		title.appendChild($('span', undefined, this.listTitle(task)));

		// Context line: repo and recency, so an interrupted task is easy to place.
		const context = row.appendChild($('.inbox-one-item-context'));
		if (task.repo) {
			context.appendChild($('span.inbox-one-item-repo', undefined, task.repo));
			context.appendChild($('span.inbox-one-item-dot-sep', undefined, '\u00b7'));
		}
		context.appendChild($('span.inbox-one-item-recency', undefined, formatElapsed(Date.now() - task.updatedAt)));

		// State line: one dot + the current state, plus the action consequence for
		// items that need attention (what approval would do), replacing the multi-step
		// progress bar and the "blocks N people" rank reason.
		const stateLine = row.appendChild($('.inbox-one-item-state'));
		stateLine.appendChild($('span.inbox-one-state-dot'));
		stateLine.appendChild($('span.inbox-one-item-statelabel', undefined, this.rowStateLabel(task)));
		const consequence = this.attentionConsequence(task);
		if (consequence) {
			stateLine.appendChild($('span.inbox-one-item-consequence', undefined, consequence));
		}

		// Inline quick actions for an approval-ready item: Skip (delegate to the
		// agent), Approve (the same confirmation modal as the detail), and Dismiss.
		if (task.state === LogicalTaskState.Decision && task.evidence?.primaryAction) {
			row.classList.add('has-quick-actions');
			const quick = row.appendChild($('.inbox-one-quick-actions'));
			const skip = quick.appendChild($('button.inbox-one-quick-action'));
			skip.title = localize('inboxOne.skipTitle', 'Skip \u2014 let the agent decide');
			skip.setAttribute('aria-label', skip.title);
			skip.appendChild($('span.codicon.codicon-debug-step-over'));
			this._register(addClick(skip, () => void this.skipToAgent(task)));
			const approve = quick.appendChild($('button.inbox-one-quick-action'));
			approve.title = localize('inboxOne.approveTitle', 'Approve');
			approve.setAttribute('aria-label', approve.title);
			approve.appendChild($('span.codicon.codicon-check'));
			this._register(addClick(approve, () => void this.confirmAndAccept(task)));
			const dismissBtn = quick.appendChild($('button.inbox-one-quick-action'));
			dismissBtn.title = localize('inboxOne.dismissTitle', 'Dismiss');
			dismissBtn.setAttribute('aria-label', dismissBtn.title);
			dismissBtn.appendChild($('span.codicon.codicon-close'));
			this._register(addClick(dismissBtn, () => this.dismiss(task)));
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

		// Eyebrow leads with the attention state + readiness (not urgency + task type).
		detail.appendChild($('.inbox-one-detail-eyebrow', undefined, this.detailEyebrow(task)));
		detail.appendChild($('h2.inbox-one-detail-title', undefined, this.listTitle(task)));

		// Meta: repo + last-updated, with a persistent "Open full session" affordance.
		const meta = detail.appendChild($('.inbox-one-detail-meta'));
		if (task.repo) {
			meta.appendChild($('span', undefined, task.repo));
			meta.appendChild($('span.inbox-one-detail-dot-sep', undefined, '\u00b7'));
		}
		meta.appendChild($('span', undefined, localize('inboxOne.updatedAgo', 'Updated {0}', formatElapsed(Date.now() - task.updatedAt))));
		const openLink = meta.appendChild($('a.inbox-one-detail-open-session', undefined, localize('inboxOne.openFullSession', 'Open full session \u2192')));
		this._register(addClick(openLink, () => this.openWorkerSession(task)));

		if (task.state === LogicalTaskState.Decision) {
			this.renderDecisionPanel(detail, task);
		} else if (task.state === LogicalTaskState.Completed) {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.completedNote', 'Completed. History preserved.')));
			const actions = detail.appendChild($('.inbox-one-detail-actions'));
			const reopen = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, localize('inboxOne.reopen', 'Reopen with Diffy')));
			this._register(addClick(reopen, () => this.openInlineComposer(task, 'reopen')));
			const archive = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.archiveBtn', 'Archive')));
			this._register(addClick(archive, () => this.dismiss(task)));
		} else if (task.state === LogicalTaskState.Archived) {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.archivedNote', 'Archived. History preserved.')));
			const actions = detail.appendChild($('.inbox-one-detail-actions'));
			const restore = actions.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, `${localize('inboxOne.restore', 'Restore')} \u25b8`));
			this._register(addClick(restore, () => this.restore(task)));
			const del = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.deleteBtn', 'Delete')));
			this._register(addClick(del, () => this.deleteTask(task)));
		} else if (task.state === LogicalTaskState.Cooking || task.state === LogicalTaskState.Confirming) {
			detail.appendChild($('.inbox-one-detail-done', undefined, localize('inboxOne.cookingNote', 'Diffy is working on this. Evidence will land here when ready.')));
			const actions = detail.appendChild($('.inbox-one-detail-actions'));
			const cancel = actions.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.cancelWork', 'Cancel work')));
			this._register(addClick(cancel, () => this.cancelWork(task)));
		}

		this.renderInlineComposer(detail, task);
	}

	/** The detail eyebrow: the item's attention state, plus a readiness phrase for decisions. */
	private detailEyebrow(task: ILogicalTask): string {
		switch (task.state) {
			case LogicalTaskState.Decision: {
				const readiness = task.evidence?.primaryAction
					? localize('inboxOne.readyForApproval', 'Ready for approval')
					: task.evidence?.customAsk
						? localize('inboxOne.needsDecision', 'Needs your decision')
						: localize('inboxOne.readyToReview', 'Ready to review');
				return `${localize('inboxOne.needsAttention', 'Needs attention')} \u00b7 ${readiness}`;
			}
			case LogicalTaskState.Cooking:
			case LogicalTaskState.Confirming:
				return localize('inboxOne.inProgress', 'In progress');
			case LogicalTaskState.Completed:
				return localize('inboxOne.complete', 'Complete');
			case LogicalTaskState.Archived:
				return localize('inboxOne.archive', 'Archive');
			default:
				return '';
		}
	}

	/**
	 * The consolidated decision brief (refined UX D5/D6/D8/D9): a single panel that
	 * states the proposed action, one short explanation, a neutral FYI for
	 * non-blocking uncertainty, a collapsed Review (decisions + evidence), and the
	 * decision controls next to the recommendation. Detailed consequences are shown
	 * only in the post-approve modal (D10), never on this default screen.
	 */
	private renderDecisionPanel(detail: HTMLElement, task: ILogicalTask): void {
		const pack = task.evidence;
		const action = pack?.primaryAction;
		const panel = detail.appendChild($('.inbox-one-decision-panel'));
		const body = panel.appendChild($('.inbox-one-decision-body'));

		// The proposed action, stated directly.
		if (action) {
			body.appendChild($('h3.inbox-one-decision-action', undefined, this.actionStatement(action)));
		} else if (pack?.customAsk) {
			body.appendChild($('h3.inbox-one-decision-action', undefined, localize('inboxOne.needsDecision', 'Needs your decision')));
		}
		// One short explanation of what the agent did and why.
		if (pack?.decisionSentence) {
			body.appendChild($('.inbox-one-decision-summary', undefined, pack.decisionSentence));
		}
		if (!action && pack?.customAsk) {
			body.appendChild($('.inbox-one-decision-summary', undefined, pack.customAsk));
		}
		// Non-blocking uncertainty as a neutral FYI, not a warning.
		if (pack?.gapLine) {
			const fyi = body.appendChild($('.inbox-one-decision-fyi'));
			fyi.appendChild($('span.inbox-one-decision-fyi-label', undefined, localize('inboxOne.fyiLabel', 'FYI:')));
			fyi.appendChild($('span', undefined, ` ${pack.gapLine}`));
		}
		// Progressive disclosure: Review -> Decisions (conclusions) + Evidence (links).
		if (pack && pack.claims.length) {
			this.renderReview(body, pack.claims);
		}

		// Decision controls, next to the recommendation.
		const footer = panel.appendChild($('.inbox-one-decision-footer'));
		if (action) {
			footer.appendChild($('span.inbox-one-decision-reversibility', undefined, buildConfirmation(action.actionType, action.payload as IActionPayloads[typeof action.actionType]).reversibilityLine));
		}
		footer.appendChild($('span.inbox-one-decision-spacer'));
		const notNow = footer.appendChild($('button.inbox-one-action.inbox-one-action-quiet', undefined, localize('inboxOne.notNow', 'Not now')));
		this._register(addClick(notNow, () => this.dismiss(task)));
		const requestChanges = footer.appendChild($('button.inbox-one-action', undefined, localize('inboxOne.requestChanges', 'Request changes')));
		this._register(addClick(requestChanges, () => this.steer(task)));
		if (action) {
			const approve = footer.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, action.label));
			this._register(addClick(approve, () => void this.confirmAndAccept(task)));
		} else if (pack?.customAsk) {
			const steerPrimary = footer.appendChild($('button.inbox-one-action.inbox-one-action-primary', undefined, localize('inboxOne.steer', 'Steer')));
			this._register(addClick(steerPrimary, () => this.steer(task)));
		}
	}

	/** A concrete, host-generated statement of the proposed action (first confirmation effect line). */
	private actionStatement(action: IPrimaryAction): string {
		const effect = buildConfirmation(action.actionType, action.payload as IActionPayloads[typeof action.actionType]).effectLines[0];
		return effect ? effect.charAt(0).toUpperCase() + effect.slice(1) : action.label;
	}

	/** The collapsed Review section: decisions (claim conclusions) + evidence (receipt links). */
	private renderReview(body: HTMLElement, claims: readonly IEvidenceClaim[]): void {
		const disclosure = body.appendChild($('details.inbox-one-review')) as HTMLDetailsElement;
		disclosure.appendChild($('summary.inbox-one-review-summary', undefined, localize('inboxOne.review', 'Review')));
		const content = disclosure.appendChild($('.inbox-one-review-content'));

		const decisions = content.appendChild($('.inbox-one-review-group'));
		decisions.appendChild($('h4.inbox-one-review-group-title', undefined, localize('inboxOne.decisions', 'Decisions')));
		const dlist = decisions.appendChild($('ul.inbox-one-review-list'));
		for (const claim of claims) {
			dlist.appendChild($('li', undefined, claim.text));
		}

		const withReceipts = claims.filter(c => c.receiptLink);
		if (withReceipts.length) {
			const evidence = content.appendChild($('.inbox-one-review-group'));
			evidence.appendChild($('h4.inbox-one-review-group-title', undefined, localize('inboxOne.evidence', 'Evidence')));
			const elist = evidence.appendChild($('ul.inbox-one-review-list'));
			for (const claim of withReceipts) {
				const li = elist.appendChild($('li'));
				const link = li.appendChild($('a.inbox-one-claim-receipt', undefined, claim.text));
				this._register(addClick(link, () => this.openReceipt(claim.receiptLink!)));
			}
		}
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

	/** Host-generated typed confirmation, shown as a modal only after Approve is chosen (design 7.3, D10). */
	private async confirmAndAccept(task: ILogicalTask): Promise<void> {
		const action = task.evidence?.primaryAction;
		if (!action) {
			void this.accept(task);
			return;
		}
		const confirmation = buildConfirmation(action.actionType, action.payload as IActionPayloads[typeof action.actionType]);
		const detailLines = [
			...confirmation.effectLines.map(line => `\u2022 ${line}`),
			'',
			confirmation.reversibilityLine,
		];
		if (task.evidence?.gapLine) {
			detailLines.push(`FYI: ${task.evidence.gapLine}`);
		}
		const { result } = await this.dialogService.prompt<boolean>({
			type: confirmation.highlight ? Severity.Warning : Severity.Info,
			message: localize('inboxOne.confirmTitle', 'Approve \u2014 {0}?', action.label),
			detail: detailLines.join('\n'),
			buttons: [{ label: action.label, run: () => true }],
			cancelButton: true,
		});
		if (result) {
			void this.accept(task);
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

	/** Row "Skip": hand the decision back to the agent to proceed as it judges best (reuses steer). */
	private async skipToAgent(task: ILogicalTask): Promise<void> {
		await this.continueTask(task, 'steer', localize('inboxOne.skipNote', 'You decide how best to proceed \u2014 take the action you judge is right, or tell me what you need.'));
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

	/** Whether a task matches the free-text list filter (title, repo, and current state). */
	private matchesQuery(task: ILogicalTask, query: string): boolean {
		const haystack = [
			this.listTitle(task),
			task.repo ?? '',
			task.type,
			task.rankReason ?? '',
			this.stateLabel(task.state),
		].join(' ').toLowerCase();
		return haystack.includes(query);
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

	/** The single current-state label for a list row (replaces the multi-step progress bar). */
	private rowStateLabel(task: ILogicalTask): string {
		switch (task.state) {
			case LogicalTaskState.Blocked: return localize('inboxOne.rowBlocked', 'Needs input');
			case LogicalTaskState.Decision:
				if (task.evidence?.primaryAction) { return localize('inboxOne.rowReady', 'Ready for approval'); }
				if (task.evidence?.customAsk) { return localize('inboxOne.rowDecide', 'Needs your decision'); }
				return localize('inboxOne.rowReview', 'Ready to review');
			case LogicalTaskState.Cooking: return localize('inboxOne.rowWorking', 'Working');
			case LogicalTaskState.Confirming: return localize('inboxOne.rowAssembling', 'Assembling evidence');
			case LogicalTaskState.Completed: return localize('inboxOne.rowComplete', 'Complete');
			case LogicalTaskState.Archived: return localize('inboxOne.rowArchived', 'Archived');
			default: return '';
		}
	}

	/** For a needs-attention row: a short "what approval does" consequence, if the item has a typed action. */
	private attentionConsequence(task: ILogicalTask): string | undefined {
		if (task.state !== LogicalTaskState.Decision) {
			return undefined;
		}
		const action = task.evidence?.primaryAction;
		return action ? this.consequenceLine(action.actionType, action.payload) : undefined;
	}

	/** Concise, host-derived consequence copy for a typed action ("Creates 1 issue", "Merges PR #842"). */
	private consequenceLine(actionType: ActionType, payload: unknown): string | undefined {
		const p = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
		const num = (k: string): number | undefined => typeof p[k] === 'number' ? p[k] as number : undefined;
		const str = (k: string): string => typeof p[k] === 'string' ? p[k] as string : '';
		const arrLen = (k: string): number => Array.isArray(p[k]) ? (p[k] as unknown[]).length : 0;
		switch (actionType) {
			case ActionType.ApprovePr: return localize('inboxOne.conseqApprove', 'Approves PR #{0}', num('prNumber') ?? '?');
			case ActionType.MergePr: return localize('inboxOne.conseqMerge', 'Merges PR #{0}', num('prNumber') ?? '?');
			case ActionType.CreateIssues: {
				const n = arrLen('issues');
				return n === 1 ? localize('inboxOne.conseqIssue1', 'Creates 1 issue') : localize('inboxOne.conseqIssueN', 'Creates {0} issues', n);
			}
			case ActionType.AddLabels: {
				const n = arrLen('add');
				return n === 1
					? localize('inboxOne.conseqLabel1', 'Adds 1 label to #{0}', num('targetNumber') ?? '?')
					: localize('inboxOne.conseqLabelN', 'Adds {0} labels to #{1}', n, num('targetNumber') ?? '?');
			}
			case ActionType.Comment: return localize('inboxOne.conseqComment', 'Comments on #{0}', num('targetNumber') ?? '?');
			case ActionType.DispatchFix: return localize('inboxOne.conseqFix', 'Starts a fix');
			case ActionType.Deploy: return localize('inboxOne.conseqDeploy', 'Deploys to {0}', str('env'));
			case ActionType.GrantScope: return localize('inboxOne.conseqGrant', 'Grants {0}', str('scope'));
			default: return undefined;
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
