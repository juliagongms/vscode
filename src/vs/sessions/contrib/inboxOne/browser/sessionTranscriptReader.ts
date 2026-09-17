/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatProgress } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatModel, IChatProgressResponseContent } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';

/** How many times to poll the transcript before giving up on the marker. */
const DEFAULT_MAX_ATTEMPTS = 6;
/** Delay between transcript polls (ms). */
const DEFAULT_RETRY_DELAY_MS = 1500;

/** Reads only the most recent turn from the live chat model used to run it. */
export function readChatModelResponseText(model: IChatModel): string | undefined {
	const parts = model.getRequests().at(-1)?.response?.response.value;
	if (!parts) {
		return undefined;
	}
	const text = responseText(parts);
	return text.trim().length > 0 ? text : undefined;
}

/**
 * Reads a background agent session's transcript by resource and returns the
 * assistant response text that carries a fenced block marked by {@link marker}.
 *
 * Dispatched inbox sessions (workers, the distiller) are background agent-host
 * sessions that are never opened in a chat editor, so their transcript is NOT
 * registered with the workbench `IChatService`. This reads them through
 * {@link IChatSessionsService.getChatSessionHistory}, which resolves a session's
 * history by resource without retaining/opening it -- the provider-neutral path
 * the sessions UI uses for agent-host and cloud sessions. The block usually
 * precedes a trailing tool call (e.g. task_complete), and a later turn can be
 * just a summary, so we scan responses newest-first for the one that actually
 * carries the marker and fall back to the newest non-empty response.
 *
 * The read is polled with a short backoff: `getChatSessionHistory` returns the
 * retained session's snapshot plus its in-flight streamed turn while the session
 * is live, and falls back to a fresh provider fetch once it is released, so at
 * the exact turn-end edge the marker can lag by a beat. Polling a few times
 * absorbs that race without any session-runtime coupling; the first attempt that
 * sees the marker wins. The streamed turn is cleared by the runtime at the start
 * of each request, so it only ever carries the current turn's output.
 */
export async function readSessionResponseText(
	chatSessions: IChatSessionsService,
	sessionRef: string,
	marker: string,
	logService: ILogService,
	maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
	retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<string | undefined> {
	let uri: URI;
	try {
		uri = URI.parse(sessionRef);
	} catch {
		return undefined;
	}

	let newestNonEmpty: string | undefined;
	let lastHistoryLen = 0;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			await timeout(retryDelayMs);
		}
		let history;
		try {
			history = await chatSessions.getChatSessionHistory(uri, CancellationToken.None);
		} catch (err) {
			logService.trace(`[inboxOne] transcript: history read failed for ${sessionRef}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (!history || history.length === 0) {
			continue;
		}
		lastHistoryLen = history.length;
		// Only consider the CURRENT turn's output: responses after the last request
		// (the most recent brief / steer / finalize prompt). This prevents re-landing
		// a stale block from an earlier turn -- e.g. after a steer whose reply had no
		// fresh block, so the caller then asks the worker to finalize a new one.
		let lastRequestIdx = -1;
		for (let i = history.length - 1; i >= 0; i--) {
			if (history[i].type === 'request') {
				lastRequestIdx = i;
				break;
			}
		}
		let turnNewest: string | undefined;
		for (let i = history.length - 1; i > lastRequestIdx; i--) {
			const item = history[i];
			if (item.type !== 'response') {
				continue;
			}
			const text = responseText(item.parts);
			if (text.trim().length === 0) {
				continue;
			}
			if (turnNewest === undefined) {
				turnNewest = text;
			}
			if (text.includes(marker)) {
				logService.info(`[inboxOne] transcript: '${marker}' found for ${sessionRef} on attempt ${attempt + 1} (len=${text.length})`);
				return text;
			}
		}
		if (turnNewest !== undefined) {
			newestNonEmpty = turnNewest;
		}
	}
	logService.info(`[inboxOne] transcript: '${marker}' not found for ${sessionRef} after ${maxAttempts} attempt(s) (history=${lastHistoryLen})`);
	return newestNonEmpty;
}

/** Concatenates the markdown text of a response's progress parts. */
function responseText(parts: readonly (IChatProgress | IChatProgressResponseContent)[]): string {
	let text = '';
	for (const part of parts) {
		if (part.kind === 'markdownContent') {
			text += part.content.value;
		}
	}
	return text;
}
