/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChatSessionsService } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { readChatModelResponseText, readSessionResponseText } from '../../browser/sessionTranscriptReader.js';

const MARK = '```inbox-one-result';

function resp(text: string) {
	return { type: 'response', parts: [{ kind: 'markdownContent', content: { value: text } }] };
}
function req(prompt: string) {
	return { type: 'request', prompt };
}
function fakeChatSessions(history: readonly unknown[]): IChatSessionsService {
	return { async getChatSessionHistory() { return history; } } as unknown as IChatSessionsService;
}

suite('Inbox One - sessionTranscriptReader', () => {

	test('reads only the latest completed chat-model turn', () => {
		const model = {
			getRequests: () => [
				{ response: { response: { value: [{ kind: 'markdownContent', content: { value: 'stale' } }] } } },
				{ response: { response: { value: [{ kind: 'markdownContent', content: { value: `${MARK}\n{"title":"fresh"}\n\`\`\`` } }] } } },
			],
		};

		assert.strictEqual(readChatModelResponseText(model as never), `${MARK}\n{"title":"fresh"}\n\`\`\``);
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('after a steer, reads the current-turn block and ignores the stale earlier one', async () => {
		const history = [
			req('brief'),
			resp('First pass.\n' + MARK + '\n{"decisionSentence":"OLD"}\n```'),
			req('steer: also consider mobile'),
			resp('Reconsidered.\n' + MARK + '\n{"decisionSentence":"NEW"}\n```'),
		];
		const text = await readSessionResponseText(fakeChatSessions(history), 'agent-host://s', MARK, new NullLogService(), 1, 0);
		assert.ok(text?.includes('NEW') && !text.includes('OLD'), 'reads the fresh block from the latest turn');
	});

	test('when the current turn has no block, does not return the stale earlier block', async () => {
		const history = [
			req('brief'),
			resp(MARK + '\n{"decisionSentence":"OLD"}\n```'),
			req('steer'),
			resp('Sure, I updated my thinking, but I only replied in prose here.'),
		];
		const text = await readSessionResponseText(fakeChatSessions(history), 'agent-host://s', MARK, new NullLogService(), 1, 0);
		assert.ok(!text?.includes(MARK), 'returns current prose (so the caller asks to finalize), not the stale block');
	});

	test('reads the block on a normal first turn', async () => {
		const history = [
			req('brief'),
			resp('Done.\n' + MARK + '\n{"decisionSentence":"ONLY"}\n```'),
		];
		const text = await readSessionResponseText(fakeChatSessions(history), 'agent-host://s', MARK, new NullLogService(), 1, 0);
		assert.ok(text?.includes('ONLY'));
	});
});
