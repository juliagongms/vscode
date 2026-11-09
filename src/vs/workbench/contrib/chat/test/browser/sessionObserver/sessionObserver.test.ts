/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ChatDraftRequestService } from '../../../browser/sessionObserver/chatDraftRequestService.js';
import { CopilotCliEventMapper, cliUserOrigin } from '../../../browser/sessionObserver/copilotCliTranscriptSource.js';
import { IChatDraftResolution } from '../../../common/sessionObserver/chatSessionObserver.js';

suite('chatSessionObserver', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const t = (s: number) => new Date(Date.UTC(2026, 10, 8, 18, 0, s)).toISOString();
	let n = 0;
	const ev = (type: string, s: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type, id: `e${++n}`, timestamp: t(s), data, ...extra });

	test('the CLI mapper tells the user\'s words from injected ones', () => {
		assert.strictEqual(cliUserOrigin({}, 'Fix it'), 'user');
		assert.strictEqual(cliUserOrigin({ source: 'autopilot' }, 'continue'), 'autopilot');
		assert.strictEqual(cliUserOrigin({ source: 'skill-pdf' }, 'x'), 'skill');
		assert.strictEqual(cliUserOrigin({}, '<system_notification>done</system_notification>'), 'notification');
	});

	test('the CLI mapper keeps state across batches: tools, edits, questions, steering and hand-backs', () => {
		n = 0;
		const m = new CopilotCliEventMapper();
		const first = m.map([
			ev('session.start', 0, { selectedModel: 'claude-opus-5.5', context: { repository: 'acme/pay', branch: 'fix/retry' } }),
			ev('user.message', 1, { content: 'Fix retries; keep it minimal' }),
			ev('assistant.message', 2, { content: '', reasoningText: 'Look first.', toolRequests: [{ toolCallId: 'c1', name: 'edit', arguments: { path: '/w/a.ts', old_str: 'a', new_str: 'b' } }] }),
			ev('tool.execution_start', 3, { toolCallId: 'c1', toolName: 'edit', arguments: { path: '/w/a.ts', old_str: 'a', new_str: 'b' } }),
		]);
		assert.deepStrictEqual(first.map(e => e.kind), ['turnStarted', 'userMessage', 'reasoning', 'toolCall']);
		assert.strictEqual(m.status, 'working');

		const second = m.map([
			ev('tool.execution_complete', 4, { toolCallId: 'c1', success: true, result: { content: 'edited' } }),
			ev('user.message', 5, { content: 'also add a test', delivery: 'steering' }),
			ev('assistant.message', 6, { content: '', toolRequests: [{ toolCallId: 'q1', name: 'ask_user', arguments: { question: 'Which runner?', choices: ['vitest', 'mocha'] } }] }),
		]);
		assert.deepStrictEqual(second.map(e => e.kind), ['toolOutput', 'toolResult', 'edit', 'userMessage', 'toolCall', 'question']);
		// A steering message joins the running turn rather than starting one.
		assert.strictEqual(second[3].turnId, first[0].turnId);
		const q = second[5];
		assert.ok(q.kind === 'question' && q.questions[0].options?.join() === 'vitest,mocha');
		assert.strictEqual(m.status, 'question');

		const third = m.map([
			ev('tool.execution_complete', 7, { toolCallId: 'q1', success: true, result: { content: 'vitest' } }),
			ev('assistant.message', 8, { content: 'Done: retries fixed, test added.' }),
			ev('assistant.turn_end', 9, {}),
		]);
		assert.deepStrictEqual(third.map(e => e.kind), ['toolOutput', 'toolResult', 'questionAnswer', 'agentText', 'turnEnded']);
		assert.strictEqual(m.status, 'waiting');
		assert.strictEqual(m.repository, 'acme/pay');
	});

	test('drafts: one per session per owner, edit then send resolves with the edit', () => {
		const drafts = store.add(new ChatDraftRequestService());
		const resolved: IChatDraftResolution[] = [];
		store.add(drafts.onDidResolveDraft(r => resolved.push(r)));
		const session = URI.parse('copilotcli:/s1');
		drafts.setDraft({ id: 'd1', owner: 'ext', session, text: 'Stop retrying the same test', label: 'Suggested', createdAt: 1 });
		drafts.setDraft({ id: 'd2', owner: 'ext', session, text: 'Run the full suite', label: 'Suggested', createdAt: 2 });
		assert.deepStrictEqual(drafts.getDrafts(session).map(d => d.id), ['d2']);
		assert.deepStrictEqual(resolved.map(r => [r.draft.id, r.outcome]), [['d1', 'expired']]);

		drafts.reportDraftState('d2', 'editing', 'chatView');
		assert.strictEqual(drafts.getDrafts(session).length, 0);
		assert.strictEqual(drafts.editingDraft(session)?.id, 'd2');
		drafts.resolveDraft('d2', 'steered', { finalText: 'Run the full suite first', edited: true });
		assert.deepStrictEqual(resolved.at(-1), { draft: resolved.at(-1)!.draft, outcome: 'steered', edited: true, finalText: 'Run the full suite first' });
		assert.strictEqual(drafts.editingDraft(session), undefined);
	});
});
