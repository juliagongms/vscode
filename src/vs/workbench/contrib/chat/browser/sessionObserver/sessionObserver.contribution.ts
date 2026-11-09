/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { Extensions as ViewExtensions, ICustomViewDescriptor, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, WindowEnablement } from '../../../../common/views.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { isProposedApiEnabled } from '../../../../services/extensions/common/extensions.js';
import { ExtensionsRegistry } from '../../../../services/extensions/common/extensionsRegistry.js';
import { WebviewViewPane } from '../../../webviewView/browser/webviewViewPane.js';
import { IChatDraftRequestService, IChatInputSuggestionService, IChatSessionObserverService } from '../../common/sessionObserver/chatSessionObserver.js';
import { ChatViewContainerId } from '../chat.js';
import { ChatDraftRequestService } from './chatDraftRequestService.js';
import { ChatInputSuggestionService } from './chatInputSuggestionService.js';
import { ChatSessionObserverService } from './chatSessionObserverService.js';

registerSingleton(IChatSessionObserverService, ChatSessionObserverService, InstantiationType.Delayed);
registerSingleton(IChatDraftRequestService, ChatDraftRequestService, InstantiationType.Delayed);
registerSingleton(IChatInputSuggestionService, ChatInputSuggestionService, InstantiationType.Delayed);

// ---- N4: panels beside the active chat session (proposed API `chatSessionPanel`) ----

interface IChatSessionPanelContribution {
	readonly id: string;
	readonly title: string;
	readonly icon?: string;
}

const chatSessionPanelsExtensionPoint = ExtensionsRegistry.registerExtensionPoint<IChatSessionPanelContribution[]>({
	extensionPoint: 'chatSessionPanels',
	jsonSchema: {
		description: localize('chatSessionPanels', "Contributes webview panels that live beside the active chat session (proposed API `chatSessionPanel`)."),
		type: 'array',
		items: {
			type: 'object',
			additionalProperties: false,
			required: ['id', 'title'],
			properties: {
				id: { type: 'string', description: localize('chatSessionPanels.id', "The panel id; also the id passed to `registerChatSessionPanelProvider`.") },
				title: { type: 'string', description: localize('chatSessionPanels.title', "The panel title.") },
				icon: { type: 'string', description: localize('chatSessionPanels.icon', "A codicon id, e.g. `pulse`.") },
			},
		},
	},
	activationEventsGenerator: function* (contributions) {
		for (const c of contributions) {
			yield `onView:${c.id}`;
		}
	},
});

/** The Agents Window's container for session panels, in the side pane next to the session. */
export const CHAT_SESSION_PANELS_CONTAINER_ID = 'workbench.view.chatSessionPanels';

const agentsWindowContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: CHAT_SESSION_PANELS_CONTAINER_ID,
	title: localize2('chatSessionPanels.container', "Session"),
	icon: Codicon.pulse,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CHAT_SESSION_PANELS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: CHAT_SESSION_PANELS_CONTAINER_ID,
	hideIfEmpty: true,
	order: 100,
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar);

class ChatSessionPanelsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.chatSessionPanels';

	private readonly registered = this._register(new DisposableMap<string>());

	constructor(@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService) {
		super();
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		chatSessionPanelsExtensionPoint.setHandler((_extensions, delta) => {
			for (const ext of delta.removed) {
				for (const c of ext.value) {
					this.registered.deleteAndDispose(c.id);
				}
			}
			for (const ext of delta.added) {
				if (!isProposedApiEnabled(ext.description, 'chatSessionPanel')) {
					ext.collector.error(localize('chatSessionPanels.proposal', "Contributing `chatSessionPanels` requires the `chatSessionPanel` API proposal."));
					continue;
				}
				for (const c of ext.value) {
					// Editor windows: stacked with the Chat view in its container. Agents Window: the side pane.
					const container = environmentService.isSessionsWindow ? agentsWindowContainer : containers.get(ChatViewContainerId);
					if (!container) {
						continue;
					}
					const icon = c.icon ? ThemeIcon.fromString(c.icon) : undefined;
					const descriptor: ICustomViewDescriptor = {
						type: 'webview',
						id: c.id,
						name: { value: c.title, original: c.title },
						ctorDescriptor: new SyncDescriptor(WebviewViewPane),
						containerIcon: icon ?? Codicon.pulse,
						canToggleVisibility: true,
						canMoveView: true,
						collapsed: !environmentService.isSessionsWindow,
						order: environmentService.isSessionsWindow ? 0 : -1,
						extensionId: ext.description.identifier,
						originalContainerId: container.id,
						windowEnablement: WindowEnablement.Both,
					};
					viewsRegistry.registerViews([descriptor], container);
					this.registered.set(c.id, { dispose: () => viewsRegistry.deregisterViews([descriptor], container) });
				}
			}
		});
	}
}

registerWorkbenchContribution2(ChatSessionPanelsContribution.ID, ChatSessionPanelsContribution, WorkbenchPhase.BlockStartup);
