/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { validateWorkerResult } from '../../common/emitResult.js';
import { deriveRankSignals, parseWorkerResult } from '../../common/parseWorkerResult.js';
import { EventSource, ILogicalTask, InboxOneTier, LogicalTaskState } from '../../common/inboxOneTypes.js';
import { rank } from '../../common/ranking.js';
import { ITranscriptSource, TranscriptWorkerResultReader } from '../../common/workerResult.js';

function task(kind: 'pr' | 'check' | 'issue' | 'security' = 'pr'): ILogicalTask {
	return {
		id: 't1', inboxId: 'my', groupKey: `acme/api:${kind}:1`, type: 'code-review', state: LogicalTaskState.Cooking,
		sourceEvent: { deliveryId: 'd', source: EventSource.World, type: 'pull_request', subject: { kind, id: '842' }, receivedAt: 0 },
		attempts: [], currentAttempt: 0, route: 'r', createdAt: 0, updatedAt: 0,
	};
}

const GOOD_BLOCK = [
	'I reviewed the PR. Everything looks good.',
	'',
	'```inbox-one-result',
	JSON.stringify({
		action_type: 'approve_pr',
		payload: { repo: 'acme/api', prNumber: 842 },
		label: 'Approve PR',
		title: 'PR #842 ready to approve',
		decisionSentence: 'PR #842 is ready to approve',
		claims: [{ text: '47/47 checks pass', receiptLink: 'https://run/1', rung: 2 }],
		gapLine: 'Not verified: behavior under production load',
	}),
	'```',
].join('\n');

suite('Inbox One - parseWorkerResult', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('extracts and maps the fenced inbox-one-result block', () => {
		const raw = parseWorkerResult(GOOD_BLOCK);
		assert.ok(raw);
		assert.strictEqual(raw!.actionType, 'approve_pr');
		assert.strictEqual(raw!.decisionSentence, 'PR #842 is ready to approve');
		assert.strictEqual(raw!.label, 'Approve PR');
		assert.strictEqual(raw!.title, 'PR #842 ready to approve');
		assert.strictEqual(raw!.claims!.length, 1);
		assert.strictEqual(raw!.claims![0].rung, 2);
		// The parsed raw result must pass host validation into an evidence pack.
		const validated = validateWorkerResult(raw!);
		assert.strictEqual(validated.ok, true);
	});

	test('takes the last block when several are present', () => {
		const text = GOOD_BLOCK + '\n```inbox-one-result\n' + JSON.stringify({ decisionSentence: 'newer', claims: [{ text: 'x', rung: 1 }], gapLine: 'g' }) + '\n```';
		const raw = parseWorkerResult(text);
		assert.strictEqual(raw!.decisionSentence, 'newer');
	});

	test('returns undefined when no block or malformed JSON', () => {
		assert.strictEqual(parseWorkerResult('no block here'), undefined);
		assert.strictEqual(parseWorkerResult(''), undefined);
		assert.strictEqual(parseWorkerResult('```inbox-one-result\n{ not json ```'), undefined);
	});

	test('derives evidence confidence from the strongest claim rung', () => {
		const strong = deriveRankSignals({ claims: [{ text: 'a', rung: 2 }] }, task('pr'));
		assert.strictEqual(strong.evidenceConfidence, 0.9);
		const weak = deriveRankSignals({ claims: [{ text: 'a', rung: 0 }] }, task('pr'));
		assert.strictEqual(weak.evidenceConfidence, 0.5);
	});

	test('derives event-kind signals (pr/check/security) so the tier is computed, not fixed', () => {
		assert.strictEqual(deriveRankSignals({ claims: [] }, task('pr')).blocking, true);
		assert.strictEqual(deriveRankSignals({ claims: [] }, task('check')).blocking, true);
		assert.strictEqual(deriveRankSignals({ claims: [] }, task('security')).urgency, 0.7);
	});
});

class FakeTranscript implements ITranscriptSource {
	constructor(private readonly text: string | undefined) { }
	async readFinalMessage(): Promise<string | undefined> { return this.text; }
}

suite('Inbox One - TranscriptWorkerResultReader', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads, parses, and derives signals into a ranked output', async () => {
		const reader = new TranscriptWorkerResultReader(new FakeTranscript(GOOD_BLOCK));
		const read = await reader.read(task('pr'), 'agent-host-session://acme/w1');
		assert.ok(read.output);
		assert.strictEqual(read.hadContent, true);
		assert.strictEqual(read.output!.result.actionType, 'approve_pr');
		// The derived signals produce a real tier via the host ranker (not hardcoded).
		const ranked = rank(read.output!.signals);
		assert.ok([InboxOneTier.Urgent, InboxOneTier.Fyi, InboxOneTier.Critical].includes(ranked.tier));
		assert.ok(ranked.reason.length > 0);
	});

	test('reports content-without-a-block when the transcript has prose but no result block', async () => {
		const reader = new TranscriptWorkerResultReader(new FakeTranscript('just some prose'));
		const read = await reader.read(task('pr'), 'ref');
		assert.strictEqual(read.output, undefined);
		assert.strictEqual(read.hadContent, true, 'the worker produced text, just no parseable block');
	});

	test('reports an empty read when there is no transcript content', async () => {
		const reader = new TranscriptWorkerResultReader(new FakeTranscript(undefined));
		const read = await reader.read(task('pr'), 'ref');
		assert.strictEqual(read.output, undefined);
		assert.strictEqual(read.hadContent, false, 'nothing was produced yet -- the caller must keep waiting');
	});
});
