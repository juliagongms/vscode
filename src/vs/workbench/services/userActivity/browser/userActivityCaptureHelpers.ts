/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';

// Pure helpers of the user activity capture: where a DOM element sits in the window and what it
// says, typing coalesced until a pause, text capped, and which commands are too noisy to record.

// ---- text ----

/** `text` cut to `max` characters, an ellipsis marking the cut. */
export function capText(text: string, max: number): string;
export function capText(text: string | undefined, max: number): string | undefined;
export function capText(text: string | undefined, max: number): string | undefined {
	if (text === undefined || text.length <= max) {
		return text;
	}
	return text.slice(0, Math.max(0, max - 1)) + '\u2026';
}

/** `text` in at most `max` characters: its start and its end, when it is longer. */
export function headAndTail(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const marker = '\n\u2026\n';
	const half = Math.max(0, Math.floor((max - marker.length) / 2));
	return text.slice(0, half) + marker + text.slice(text.length - half);
}

/** Whitespace collapsed and trimmed. */
export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Something that has lines, 1-based, like a text model. */
export interface ILineSource {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

/** Lines `startLine - radius` to `endLine + radius` (1-based, clamped), joined with `\n`. */
export function linesAround(source: ILineSource, startLine: number, endLine: number, radius: number): string {
	const count = source.getLineCount();
	const from = Math.max(1, Math.min(startLine, endLine) - radius);
	const to = Math.min(count, Math.max(startLine, endLine) + radius);
	const lines: string[] = [];
	for (let i = from; i <= to; i++) {
		lines.push(source.getLineContent(i));
	}
	return lines.join('\n');
}

/** A window of at most `max` characters of `text`, centred on its first occurrence of `part`. */
export function textAround(text: string, part: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const at = part ? text.indexOf(part) : -1;
	if (at < 0) {
		return capText(text, max);
	}
	const start = Math.max(0, Math.min(at - Math.floor((max - part.length) / 2), text.length - max));
	return text.slice(start, start + max);
}

// ---- typing ----

/**
 * What was typed, as a sequence of edits made it: inserted text appended, deletions taking back
 * what was typed last (a backspace corrects a typo rather than recording it).
 */
export class TypingBuffer {
	private value = '';
	private edits = 0;

	/** Applies one edit: `deleted` characters removed before the caret, then `inserted` typed. */
	apply(inserted: string, deleted: number): void {
		this.edits++;
		if (deleted > 0) {
			this.value = this.value.slice(0, Math.max(0, this.value.length - deleted));
		}
		this.value += inserted;
	}

	/** The text typed. */
	get text(): string {
		return this.value;
	}

	/** Whether any edit was applied. */
	get edited(): boolean {
		return this.edits > 0;
	}
}

/**
 * Coalesces updates per key until `idleMs` pass without one, then flushes the key's state.
 * {@link flush} flushes at once (on blur); {@link dispose} drops what is pending.
 */
export class IdleCoalescer<K, S> implements IDisposable {
	private readonly pending = new Map<K, { state: S; timer: ReturnType<typeof setTimeout> }>();

	constructor(
		private readonly idleMs: number,
		private readonly create: (key: K) => S,
		private readonly onFlush: (key: K, state: S) => void,
	) { }

	update(key: K, apply: (state: S) => void): void {
		let entry = this.pending.get(key);
		if (entry) {
			clearTimeout(entry.timer);
		} else {
			entry = { state: this.create(key), timer: undefined! };
			this.pending.set(key, entry);
		}
		apply(entry.state);
		entry.timer = setTimeout(() => this.flush(key), this.idleMs);
	}

	has(key: K): boolean {
		return this.pending.has(key);
	}

	flush(key: K): void {
		const entry = this.pending.get(key);
		if (!entry) {
			return;
		}
		clearTimeout(entry.timer);
		this.pending.delete(key);
		this.onFlush(key, entry.state);
	}

	flushAll(): void {
		for (const key of [...this.pending.keys()]) {
			this.flush(key);
		}
	}

	dispose(): void {
		for (const { timer } of this.pending.values()) {
			clearTimeout(timer);
		}
		this.pending.clear();
	}
}

// ---- commands ----

const NOISY_COMMANDS = new Set([
	'type', 'default:type', 'replacePreviousChar', 'compositionStart', 'compositionEnd', 'compositionType',
	'deleteLeft', 'deleteRight', 'deleteWordLeft', 'deleteWordRight', 'deleteAllLeft', 'deleteAllRight', 'tab', 'outdent', 'lineBreakInsert',
	'setContext', 'noop', 'getContextKeyInfo',
	'hideSuggestWidget', 'selectNextSuggestion', 'selectPrevSuggestion', 'selectNextPageSuggestion', 'selectPrevPageSuggestion', 'focusSuggestion',
	'closeParameterHints', 'showPrevParameterHint', 'showNextParameterHint',
	'editor.action.clipboardCopyAction', 'editor.action.clipboardCutAction', 'editor.action.clipboardPasteAction',
	'workbench.action.quickOpenSelectNext', 'workbench.action.quickOpenSelectPrevious', 'workbench.action.quickOpenNavigateNext', 'workbench.action.quickOpenNavigatePrevious',
	'list.focusDown', 'list.focusUp', 'list.focusFirst', 'list.focusLast', 'list.focusPageDown', 'list.focusPageUp', 'list.collapse', 'list.expand',
]);

const NOISY_PREFIXES = ['_', 'cursor', 'scroll', 'vscode.', 'editor.action.trigger', 'editor.action.inlineSuggest.', 'editor.action.wordHighlight', 'list.scroll', 'list.focus', 'quickInput.'];

/** Whether a command runs too often, or too far inside the workbench, to be worth recording. */
export function isNoisyCommand(id: string): boolean {
	if (!id || NOISY_COMMANDS.has(id) || NOISY_PREFIXES.some(p => id.startsWith(p))) {
		return true;
	}
	const lower = id.toLowerCase();
	return lower.includes('hover') || lower.includes('.scroll') || lower.includes('.cursor');
}

// ---- DOM targets ----

/** Where in the window a DOM element sits, and what it says. */
export interface IDomTarget {
	readonly area: string;
	readonly view?: string;
	readonly label?: string;
	readonly role?: string;
}

const PART_AREAS: Record<string, string> = {
	'workbench.parts.titlebar': 'titlebar',
	'workbench.parts.banner': 'titlebar',
	'workbench.parts.activitybar': 'sidebar',
	'workbench.parts.sidebar': 'sidebar',
	'workbench.parts.panel': 'panel',
	'workbench.parts.auxiliarybar': 'auxiliarybar',
	'workbench.parts.sessions': 'sessions',
	'workbench.parts.editor': 'editor',
	'workbench.parts.statusbar': 'statusbar',
};

/** Surfaces inside parts, most specific first. */
const SURFACE_AREAS: readonly (readonly [selector: string, area: string])[] = [
	['.quick-input-widget', 'quickInput'],
	['.notifications-toasts, .notifications-center', 'notifications'],
	['.monaco-dialog-box, .monaco-dialog-modal-block', 'dialog'],
	['.interactive-input-part', 'chatInput'],
	['.agent-sessions-viewer, .sessions-list-control', 'sessions'],
	['.interactive-session', 'chat'],
	['.terminal-wrapper, .integrated-terminal', 'terminal'],
	['.browser-root', 'browser'],
];

/** View containers and views whose area is named for them. */
const VIEW_AREAS: readonly (readonly [prefix: string, area: string])[] = [
	['workbench.view.explorer', 'explorer'],
	['workbench.explorer.', 'explorer'],
	['workbench.view.scm', 'scm'],
	['workbench.scm', 'scm'],
	['workbench.view.search', 'search'],
	['workbench.view.debug', 'other'],
];

function areaOfView(viewOrContainer: string | undefined): string | undefined {
	return viewOrContainer ? VIEW_AREAS.find(([prefix]) => viewOrContainer.startsWith(prefix))?.[1] : undefined;
}

/** The view container a DOM element sits in, from the id of its composite. */
export function viewContainerOf(element: Element): string | undefined {
	const composite = element.closest('.composite[id]');
	return composite?.id || undefined;
}

/**
 * The part of the window a DOM element sits in: a surface (the quick input, chat, a terminal),
 * else the view it is in, else the workbench part.
 */
export function resolveArea(element: Element, view?: string): string {
	for (const [selector, area] of SURFACE_AREAS) {
		if (element.closest(selector)) {
			return area;
		}
	}
	const byView = areaOfView(view) ?? areaOfView(viewContainerOf(element));
	if (byView) {
		return byView;
	}
	const part = element.closest('.part[id], [id^="workbench.parts."]');
	return (part && PART_AREAS[part.id]) || 'other';
}

const MAX_LABEL = 120;
const MAX_DEPTH = 8;

const IMPLICIT_ROLES: Record<string, string> = {
	BUTTON: 'button',
	A: 'link',
	TEXTAREA: 'textbox',
	SELECT: 'combobox',
	LI: 'listitem',
	IMG: 'img',
};

function implicitRole(element: Element): string | undefined {
	if (element.tagName === 'INPUT') {
		const type = (element as HTMLInputElement).type;
		return type === 'checkbox' || type === 'radio' || type === 'button' || type === 'range' ? type : type === 'submit' ? 'button' : 'textbox';
	}
	return IMPLICIT_ROLES[element.tagName];
}

function labelledBy(element: Element): string | undefined {
	const ids = element.getAttribute('aria-labelledby');
	if (!ids) {
		return undefined;
	}
	const doc = element.ownerDocument;
	// eslint-disable-next-line no-restricted-syntax -- resolving the element's own ARIA reference
	const text = ids.split(/\s+/).map(id => doc.getElementById(id)?.textContent ?? '').join(' ');
	return normalizeWhitespace(text) || undefined;
}

function isBoundary(element: Element): boolean {
	return element.classList.contains('part') || element.classList.contains('monaco-workbench');
}

/** The ARIA role of an element or of its nearest ancestor that has one (`none` and `presentation` do not count). */
export function resolveRole(element: Element): string | undefined {
	let current: Element | null = element;
	for (let depth = 0; current && depth < MAX_DEPTH && !isBoundary(current); depth++, current = current.parentElement) {
		const role = current.getAttribute('role');
		if (role && role !== 'none' && role !== 'presentation') {
			return role;
		}
		const implicit = implicitRole(current);
		if (implicit) {
			return implicit;
		}
	}
	return undefined;
}

/**
 * What an element says, from it or its nearest ancestor that has an accessible name: its
 * `aria-label`, `aria-labelledby`, `title`, or its visible text when that is short. Long text
 * is shortened. Input values are never read.
 */
export function resolveLabel(element: Element): string | undefined {
	let fallback: string | undefined;
	let textStillShort = true;
	let current: Element | null = element;
	for (let depth = 0; current && depth < MAX_DEPTH; depth++, current = current.parentElement) {
		const named = current.getAttribute('aria-label') || labelledBy(current) || current.getAttribute('title');
		if (named && normalizeWhitespace(named)) {
			return capText(normalizeWhitespace(named), MAX_LABEL);
		}
		if (textStillShort && current.tagName !== 'INPUT' && current.tagName !== 'TEXTAREA') {
			const text = normalizeWhitespace(current.textContent ?? '');
			if (text && text.length <= MAX_LABEL) {
				return text;
			}
			if (text) {
				// Ancestors only read longer: keep the start of the closest text, in case nothing names it.
				textStillShort = false;
				fallback ??= capText(text, MAX_LABEL);
			}
		}
		if (isBoundary(current)) {
			break;
		}
	}
	return fallback;
}

/** Where a DOM element sits and what it says. `viewOf` tells the view it is in, when known. */
export function resolveDomTarget(element: Element, viewOf?: (element: Element) => string | undefined): IDomTarget {
	const view = viewOf?.(element) ?? viewContainerOf(element);
	const label = resolveLabel(element);
	const role = resolveRole(element);
	return {
		area: resolveArea(element, view),
		...(view ? { view } : {}),
		...(label ? { label } : {}),
		...(role ? { role } : {}),
	};
}

// ---- input fields ----

/** Whether an element is, or sits in, a password field. Nothing of one is ever recorded. */
export function isPasswordField(element: Element | null | undefined): boolean {
	const field = element?.closest('input');
	return !!field && ((field as HTMLInputElement).type === 'password' || field.getAttribute('autocomplete')?.includes('password') === true);
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number']);

/**
 * Whether an element is a plain text field whose typing the DOM reports: an `<input>` of a text
 * type or a `<textarea>`, not a password field, and not the hidden input of a code editor or a
 * terminal (whose typing is recorded from their models, or not at all).
 */
export function isPlainTextField(element: Element | null | undefined): element is HTMLInputElement | HTMLTextAreaElement {
	if (!element) {
		return false;
	}
	if (element.tagName === 'INPUT') {
		const type = (element as HTMLInputElement).type?.toLowerCase() ?? '';
		return TEXT_INPUT_TYPES.has(type) && !isPasswordField(element);
	}
	if (element.tagName === 'TEXTAREA') {
		return !['inputarea', 'ime-text-area', 'xterm-helper-textarea'].some(c => element.classList.contains(c)) && !element.closest('.native-edit-context');
	}
	return false;
}

/** Whether a text field is a search or find query: the search view's, a find widget's. */
export function isSearchField(element: Element): boolean {
	if (element.closest('.replace-input, .replace-part')) {
		return false;
	}
	return !!element.closest('.search-widget, .find-widget .find-part, .simple-find-part');
}
