/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension, getWindow } from '../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { DockedEditorInput } from '../../../../workbench/browser/parts/editor/dockedEditorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ActiveEditorContext, AuxiliaryBarVisibleContext, IsAuxiliaryWindowContext, IsSessionsWindowContext, MainEditorAreaVisibleContext } from '../../../../workbench/common/contextkeys.js';
import { EditorExtensions, EditorInputCapabilities, IEditorFactoryRegistry, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IViewBadge } from '../../../../workbench/common/views.js';
import { chatSessionPanelRegistry, IChatSessionPanelDescriptor } from '../../../../workbench/contrib/chat/common/sessionObserver/chatSessionObserver.js';
import { Menus, SessionActivityBarGroup } from '../../../../workbench/contrib/sessions/browser/menus.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IWebviewViewService, WebviewView } from '../../../../workbench/contrib/webviewView/browser/webviewViewService.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { AgentsWindowMenus } from '../../../browser/agentsWindowMenus.js';

// Panels contributed with `chatSessionPanels` (proposed API `chatSessionPanel`) are side-pane
// tabs in the Agents Window: its side pane is an editor group. Each panel's tab hosts the
// extension's webview through the same webview-view resolver the editor window's view uses,
// and a Session Activity Bar entry opens it beside the session.

const SCHEME = 'chat-session-panel';

export class ChatSessionPanelEditorInput extends DockedEditorInput {

	static readonly ID = 'workbench.input.agentSessions.chatSessionPanel';
	static readonly EDITOR_ID = 'workbench.editor.agentSessions.chatSessionPanel';

	private _badge: IViewBadge | undefined;

	constructor(
		readonly panel: IChatSessionPanelDescriptor,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
	) {
		super(editorGroupsService, layoutService);
	}

	override get resource(): URI {
		return URI.from({ scheme: SCHEME, path: `/${this.panel.id}` });
	}

	override get typeId(): string {
		return ChatSessionPanelEditorInput.ID;
	}

	override get editorId(): string {
		return ChatSessionPanelEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return this._badge && typeof this._badge.value === 'number' && this._badge.value > 0 ? `${this.panel.title} (${this._badge.value})` : this.panel.title;
	}

	override getTitle(): string {
		return this._badge?.tooltip ? `${this.panel.title}: ${this._badge.tooltip}` : this.panel.title;
	}

	override getIcon(): ThemeIcon {
		return this.panel.icon ? ThemeIcon.fromId(this.panel.icon) : Codicon.pulse;
	}

	setBadge(badge: IViewBadge | undefined): void {
		if (this._badge?.value !== badge?.value || this._badge?.tooltip !== badge?.tooltip) {
			this._badge = badge;
			this._onDidChangeLabel.fire();
		}
	}

	override canReopen(): boolean {
		return true;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof ChatSessionPanelEditorInput && other.panel.id === this.panel.id);
	}
}

class ChatSessionPanelEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): input is ChatSessionPanelEditorInput {
		return input instanceof ChatSessionPanelEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return this.canSerialize(input) ? JSON.stringify(input.panel) : undefined;
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const panel = JSON.parse(serialized) as IChatSessionPanelDescriptor;
			return panel?.id ? instantiationService.createInstance(ChatSessionPanelEditorInput, chatSessionPanelRegistry.get(panel.id) ?? panel) : undefined;
		} catch {
			return undefined;
		}
	}
}

/** Hosts a panel's webview in the side pane, resolved by the extension's panel provider. */
export class ChatSessionPanelEditor extends EditorPane {

	static readonly ID = ChatSessionPanelEditorInput.EDITOR_ID;

	private container: HTMLElement | undefined;
	private readonly webview = this._register(new MutableDisposable<IOverlayWebview>());
	private readonly webviewStore = this._register(new DisposableStore());
	private readonly inputStore = this._register(new DisposableStore());
	private panelId: string | undefined;
	private readonly _onDidChangeVisibility = this._register(new Emitter<boolean>());
	private readonly _onDispose = this._register(new Emitter<void>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IWebviewViewService private readonly webviewViewService: IWebviewViewService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super(ChatSessionPanelEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.chat-session-panel-editor'));
		this.container.style.width = '100%';
		this.container.style.height = '100%';
	}

	override async setInput(input: ChatSessionPanelEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || !this.container) {
			return;
		}
		this.inputStore.clear();
		if (this.panelId === input.panel.id && this.webview.value) {
			this.claim();
			return;
		}
		this.resetWebview();
		this.panelId = input.panel.id;
		const webview = this.webviewService.createWebviewOverlay({
			providedViewType: input.panel.id,
			title: input.panel.title,
			options: { purpose: WebviewContentPurpose.WebviewView },
			contentOptions: {},
			extension: { id: new ExtensionIdentifier(input.panel.extensionId) },
		});
		this.webview.value = webview;
		this.claim();
		this.layoutWebview();
		const source = this.webviewStore.add(new CancellationTokenSource());
		this.webviewStore.add(toDisposable(() => source.cancel()));
		await this.extensionService.activateByEvent(`onView:${input.panel.id}`);
		let title: string | undefined;
		let description: string | undefined;
		let badge: IViewBadge | undefined;
		const self = this;
		const view: WebviewView = {
			webview,
			onDidChangeVisibility: this._onDidChangeVisibility.event,
			onDispose: this._onDispose.event,
			get title() { return title; },
			set title(value) { title = value; },
			get description() { return description; },
			set description(value) { description = value; },
			get badge() { return badge; },
			set badge(value) {
				badge = value;
				(self.input as ChatSessionPanelEditorInput | undefined)?.setBadge(value);
			},
			dispose: () => this.resetWebview(),
			show: () => { this.group.openEditor(input); },
		};
		await this.webviewViewService.resolve(input.panel.id, view, source.token);
	}

	private claim(): void {
		if (this.container && this.webview.value) {
			this.webview.value.claim(this, getWindow(this.container), undefined);
		}
	}

	private resetWebview(): void {
		this.webview.value?.release(this);
		this.webviewStore.clear();
		this.webview.clear();
		this.panelId = undefined;
	}

	private layoutWebview(): void {
		if (this.container && this.webview.value) {
			this.webview.value.setAnchorElement(this.container);
		}
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			this.claim();
			this.layoutWebview();
		} else {
			this.webview.value?.release(this);
		}
		this._onDidChangeVisibility.fire(visible);
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
		this.layoutWebview();
	}

	override focus(): void {
		super.focus();
		this.webview.value?.focus();
	}

	override dispose(): void {
		this._onDispose.fire();
		this.resetWebview();
		super.dispose();
	}
}

const panelTabWhen = ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated());

function openPanelCommandId(panelId: string): string {
	return `workbench.action.agentSessions.openChatSessionPanel.${panelId}`;
}

async function openPanel(accessor: ServicesAccessor, panel: IChatSessionPanelDescriptor): Promise<void> {
	const instantiationService = accessor.get(IInstantiationService);
	// The side pane is the main editor part's group (as for the Changes and Files tabs).
	const group = accessor.get(IEditorGroupsService).mainPart.activeGroup;
	const input = instantiationService.createInstance(ChatSessionPanelEditorInput, panel);
	const index = group.findEditors(input.resource).length > 0 ? undefined : group.count;
	await group.openEditor(input, { pinned: true, ...(index !== undefined ? { index } : {}) });
}

class ChatSessionPanelsAgentsWindowContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentSessions.chatSessionPanels';

	private readonly perPanel = this._register(new DisposableMap<string>());

	constructor() {
		super();
		this._register(Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
			EditorPaneDescriptor.create(ChatSessionPanelEditor, ChatSessionPanelEditor.ID, localize('chatSessionPanel.label', "Session Panel")),
			[new SyncDescriptor(ChatSessionPanelEditorInput)],
		));
		this._register(Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ChatSessionPanelEditorInput.ID, ChatSessionPanelEditorSerializer));
		const sync = () => {
			const panels = chatSessionPanelRegistry.all();
			for (const id of [...this.perPanel.keys()]) {
				if (!panels.some(p => p.id === id)) {
					this.perPanel.deleteAndDispose(id);
				}
			}
			for (const panel of panels) {
				if (!this.perPanel.has(panel.id)) {
					this.perPanel.set(panel.id, this.registerPanel(panel));
				}
			}
		};
		this._register(chatSessionPanelRegistry.onDidChange(sync));
		sync();
	}

	private registerPanel(panel: IChatSessionPanelDescriptor): DisposableStore {
		const store = new DisposableStore();
		const id = openPanelCommandId(panel.id);
		const icon = panel.icon ? ThemeIcon.fromId(panel.icon) : Codicon.pulse;
		store.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id,
					title: localize2('openChatSessionPanel', "{0}", panel.title),
					icon,
					f1: true,
					precondition: panelTabWhen,
					menu: [{
						id: AgentsWindowMenus.SessionsEditorTabsBarAddTab,
						group: 'navigation',
						order: 10,
						when: panelTabWhen,
					}, {
						id: AgentsWindowMenus.SessionsEmptyEditorGroupAddTab,
						group: 'navigation',
						order: 10,
						when: panelTabWhen,
					}],
				});
			}
			override run(accessor: ServicesAccessor): Promise<void> {
				return openPanel(accessor, panel);
			}
		}));
		// The entry beside Changes and Files, checked while the side pane shows the panel.
		store.add(MenuRegistry.appendMenuItem(Menus.SessionActivityBar, {
			command: {
				id,
				title: localize2('openChatSessionPanel', "{0}", panel.title),
				icon,
				precondition: panelTabWhen,
				toggled: ContextKeyExpr.and(ContextKeyExpr.or(MainEditorAreaVisibleContext, AuxiliaryBarVisibleContext), ActiveEditorContext.isEqualTo(ChatSessionPanelEditorInput.EDITOR_ID)),
			},
			group: SessionActivityBarGroup.SidePanel,
			order: 5,
			when: panelTabWhen,
		}));
		return store;
	}
}

registerWorkbenchContribution2(ChatSessionPanelsAgentsWindowContribution.ID, ChatSessionPanelsAgentsWindowContribution, WorkbenchPhase.BlockRestore);
