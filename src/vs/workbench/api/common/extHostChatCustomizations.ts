/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { illegalArgument } from '../../../base/common/errors.js';
import { URI } from '../../../base/common/uri.js';
import type { IChatCustomizationInfo } from '../../contrib/chat/common/chatCustomizationsInventory.js';
import { ExtHostChatCustomizationsShape, IMainContext, MainContext, MainThreadChatCustomizationsShape } from './extHost.protocol.js';

function toApiChatCustomization(item: IChatCustomizationInfo): vscode.ChatCustomizationInfo {
	return Object.freeze({
		id: item.id,
		name: item.name,
		description: item.description,
		kind: item.kind,
		keywords: Object.freeze([...item.keywords]),
		aliases: Object.freeze([...item.aliases]),
		domains: Object.freeze([...item.domains]),
		state: item.state,
	});
}

/**
 * Proposed API `chatCustomizations`: the connectors and MCP servers a chat session could use, and the one
 * step that makes one ready. Changes are forwarded from the window once the event has a listener.
 */
export class ExtHostChatCustomizations implements ExtHostChatCustomizationsShape {

	private readonly _proxy: MainThreadChatCustomizationsShape;
	private _listening = false;

	private readonly _onDidChangeChatCustomizations = new Emitter<void>({
		onWillAddFirstListener: () => {
			if (!this._listening) {
				this._listening = true;
				this._proxy.$startListening();
			}
		},
	});
	readonly onDidChangeChatCustomizations = this._onDidChangeChatCustomizations.event;

	constructor(mainContext: IMainContext) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadChatCustomizations);
	}

	async getChatCustomizations(sessionResource: vscode.Uri | undefined): Promise<readonly vscode.ChatCustomizationInfo[]> {
		if (sessionResource !== undefined && !URI.isUri(sessionResource)) {
			throw illegalArgument('sessionResource');
		}
		const items = await this._proxy.$getChatCustomizations(sessionResource);
		return Object.freeze(items.map(toApiChatCustomization));
	}

	fixChatCustomization(sessionResource: vscode.Uri, id: string): Promise<vscode.ChatCustomizationState> {
		if (!URI.isUri(sessionResource)) {
			throw illegalArgument('sessionResource');
		}
		if (typeof id !== 'string') {
			throw illegalArgument('id');
		}
		return this._proxy.$fixChatCustomization(sessionResource, id);
	}

	$onDidChangeChatCustomizations(): void {
		this._onDidChangeChatCustomizations.fire();
	}
}
