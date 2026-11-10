/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { FocusMode } from '../../../../../platform/native/common/native.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { ChatConfiguration, ChatNotificationMode } from '../../common/constants.js';
import { IChatSessionAttentionService, IChatSessionNotification } from '../../common/sessionObserver/chatSessionObserver.js';
import { IChatWidgetService } from '../chat.js';

/**
 * OS notifications that call the user to a session (proposed API `chatSessionAttention`), through
 * the path a session that needs input takes (`ChatWindowNotifier`): window attention, then a toast
 * that opens the session. Gated by `chat.notifyWindowOnConfirmation`.
 */
export class ChatSessionAttentionService extends Disposable implements IChatSessionAttentionService {
	declare readonly _serviceBrand: undefined;

	private readonly toasts = this._register(new DisposableMap<string>());

	constructor(
		@IHostService private readonly hostService: IHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatService private readonly chatService: IChatService,
	) {
		super();
	}

	async notify(owner: string, session: URI, notification: IChatSessionNotification): Promise<{ readonly shown: boolean; readonly clicked: boolean }> {
		const mode = this.configurationService.getValue<ChatNotificationMode>(ChatConfiguration.NotifyWindowOnConfirmation);
		const widget = this.chatWidgetService.getWidgetBySessionResource(session);
		const targetWindow = widget ? dom.getWindow(widget.domNode) : mainWindow;
		const isFocused = targetWindow.document.hasFocus();
		if (mode === ChatNotificationMode.Off || (mode !== ChatNotificationMode.Always && isFocused)) {
			return { shown: false, clicked: false };
		}

		const key = `${owner}:${session.toString()}`;
		this.toasts.deleteAndDispose(key);
		const cts = new CancellationTokenSource();
		this.toasts.set(key, toDisposable(() => cts.dispose(true)));
		try {
			if (!isFocused) {
				await this.hostService.focus(targetWindow, { mode: FocusMode.Notify });
			}
			const title = notification.title ?? this.chatService.getSession(session)?.title;
			const result = await this.hostService.showToast({
				title: sanitize(title ? localize('chatSessionAttention.title', "Session: {0}", title) : localize('chatSessionAttention.untitled', "Untitled Session")),
				body: sanitize(notification.body),
				actions: [localize('chatSessionAttention.open', "Open Session")],
				dedupeKey: `chat-session:${session.toString()}:attention`,
			}, cts.token);
			const clicked = result.clicked || typeof result.actionIndex === 'number';
			if (clicked) {
				await this.hostService.focus(targetWindow, { mode: FocusMode.Force });
				const opened = await this.chatWidgetService.openSession(session);
				opened?.focusInput();
			}
			return { shown: true, clicked };
		} finally {
			if (!cts.token.isCancellationRequested) {
				this.toasts.deleteAndDispose(key);
			}
		}
	}

	clearOwner(owner: string): void {
		for (const key of [...this.toasts.keys()]) {
			if (key.startsWith(`${owner}:`)) {
				this.toasts.deleteAndDispose(key);
			}
		}
	}
}

/** As the chat notifiers do: backticks read badly in OS toasts. */
function sanitize(text: string): string {
	return text.replace(/`/g, '\'');
}
