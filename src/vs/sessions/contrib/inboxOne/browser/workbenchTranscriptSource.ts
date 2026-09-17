/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import { ILogicalTask } from '../common/inboxOneTypes.js';
import { ITranscriptSource } from '../common/workerResult.js';
import { readChatModelResponseText, readSessionResponseText } from './sessionTranscriptReader.js';

/** The fenced block a worker emits as its machine-readable result. */
const RESULT_MARKER = '```inbox-one-result';

/**
 * Reads a finished worker session's transcript and returns the assistant text
 * that carries the emit-result block (technical spec 2.3), so
 * {@link parseWorkerResult} can extract it. With a real worker session,
 * `task_finished` produces real evidence; without one it returns `undefined` (a
 * safe no-op). Delegates the provider-neutral read (background agent sessions are
 * never opened, so their transcript is not in the workbench `IChatService`) to
 * {@link readSessionResponseText}.
 */
export class WorkbenchTranscriptSource implements ITranscriptSource {

	constructor(
		@IChatSessionsService private readonly chatSessions: IChatSessionsService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
	) { }

	async readFinalMessage(_task: ILogicalTask, sessionRef: string): Promise<string | undefined> {
		let resource: URI;
		try {
			resource = URI.parse(sessionRef);
		} catch {
			return undefined;
		}

		const activeModel = this.chatService.getSession(resource);
		const activeText = activeModel && readChatModelResponseText(activeModel);
		if (activeText !== undefined) {
			this.logService.info(`[inboxOne] transcript: read completed turn directly from live chat model for ${sessionRef} (len=${activeText.length})`);
			return activeText;
		}

		try {
			const modelRef = await this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, CancellationToken.None, 'InboxOneWorkerResult');
			if (modelRef) {
				try {
					const loadedText = readChatModelResponseText(modelRef.object);
					if (loadedText !== undefined) {
						this.logService.info(`[inboxOne] transcript: read completed turn from loaded chat model for ${sessionRef} (len=${loadedText.length})`);
						return loadedText;
					}
				} finally {
					modelRef.dispose();
				}
			}
		} catch (err) {
			this.logService.trace(`[inboxOne] transcript: chat model read failed for ${sessionRef}: ${err instanceof Error ? err.message : String(err)}`);
		}

		return readSessionResponseText(this.chatSessions, sessionRef, RESULT_MARKER, this.logService);
	}
}
