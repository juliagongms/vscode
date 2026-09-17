/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IActionPayloads } from '../../common/actionCatalog.js';
import { IExternalEffect, IGitHubWriteClient } from '../../common/actionExecutor.js';
import { ActionExecutorService, actionIdempotencyKey } from '../../browser/actionExecutorService.js';
import { ActionType, ExecutorReceiptStatus } from '../../common/inboxOneTypes.js';

class FakeGitHubClient implements IGitHubWriteClient {
	calls: string[] = [];
	nextEffect: IExternalEffect = { settled: true };
	pollState: 'pending' | 'done' | 'failed' = 'done';
	throwOn?: ActionType;

	private record(action: ActionType): Promise<IExternalEffect> {
		this.calls.push(action);
		if (this.throwOn === action) { return Promise.reject(new Error('github write failed')); }
		return Promise.resolve(this.nextEffect);
	}
	mergePr(_p: IActionPayloads[ActionType.MergePr]): Promise<IExternalEffect> { return this.record(ActionType.MergePr); }
	approvePr(_p: IActionPayloads[ActionType.ApprovePr]): Promise<IExternalEffect> { return this.record(ActionType.ApprovePr); }
	createPr(_p: IActionPayloads[ActionType.CreatePr]): Promise<IExternalEffect> { return this.record(ActionType.CreatePr); }
	comment(_p: IActionPayloads[ActionType.Comment]): Promise<IExternalEffect> { return this.record(ActionType.Comment); }
	addLabels(_p: IActionPayloads[ActionType.AddLabels]): Promise<IExternalEffect> { return this.record(ActionType.AddLabels); }
	createIssues(_p: IActionPayloads[ActionType.CreateIssues]): Promise<IExternalEffect> { return this.record(ActionType.CreateIssues); }
	deploy(_p: IActionPayloads[ActionType.Deploy]): Promise<IExternalEffect> { return this.record(ActionType.Deploy); }
	grantScope(_p: IActionPayloads[ActionType.GrantScope]): Promise<IExternalEffect> { return this.record(ActionType.GrantScope); }
	async pollEffect(_ref: string): Promise<'pending' | 'done' | 'failed'> { return this.pollState; }
}

suite('Inbox One - action executor', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	void disposables;

	function create(client = new FakeGitHubClient()): { executor: ActionExecutorService; client: FakeGitHubClient } {
		return { executor: new ActionExecutorService(client, new NullLogService()), client };
	}

	test('executes a valid merge and returns Done for a settled effect', async () => {
		const { executor, client } = create();
		const receipt = await executor.execute(ActionType.MergePr, { repo: 'acme/api', prNumber: 842, base: 'main', strategy: 'squash' }, 'k1');
		assert.strictEqual(receipt.status, ExecutorReceiptStatus.Done);
		assert.deepStrictEqual(client.calls, [ActionType.MergePr]);
	});

	test('rejects an out-of-catalog action without calling the client', async () => {
		const { executor, client } = create();
		const receipt = await executor.execute('delete_repo' as ActionType, {} as never, 'k1');
		assert.strictEqual(receipt.status, ExecutorReceiptStatus.Failed);
		assert.strictEqual(client.calls.length, 0);
	});

	test('rejects a malformed payload without calling the client', async () => {
		const { executor, client } = create();
		const receipt = await executor.execute(ActionType.MergePr, { repo: 'acme/api' } as never, 'k1');
		assert.strictEqual(receipt.status, ExecutorReceiptStatus.Failed);
		assert.strictEqual(client.calls.length, 0);
	});

	test('dispatch_fix is not a repo write and is declined by the executor', async () => {
		const { executor, client } = create();
		const receipt = await executor.execute(ActionType.DispatchFix, { repo: 'acme/api', subject: 'flaky test' }, 'k1');
		assert.strictEqual(receipt.status, ExecutorReceiptStatus.Failed);
		assert.strictEqual(client.calls.length, 0);
	});

	test('idempotent: a repeated key returns the original receipt and does not re-write (I2)', async () => {
		const { executor, client } = create();
		const first = await executor.execute(ActionType.Comment, { repo: 'r', targetNumber: 1, body: 'hi' }, 'k1');
		const second = await executor.execute(ActionType.Comment, { repo: 'r', targetNumber: 1, body: 'hi' }, 'k1');
		assert.strictEqual(first.id, second.id);
		assert.strictEqual(client.calls.length, 1);
	});

	test('an async effect enters Confirming, then resolves by reading external state', async () => {
		const client = new FakeGitHubClient();
		client.nextEffect = { settled: false, externalRef: 'run-7' };
		const { executor } = create(client);
		const receipt = await executor.execute(ActionType.Deploy, { repo: 'acme/api', env: 'prod', ref: 'abc' }, 'k1');
		assert.strictEqual(receipt.status, ExecutorReceiptStatus.Confirming);

		client.pollState = 'done';
		const confirmed = await executor.confirm(receipt);
		assert.strictEqual(confirmed.status, ExecutorReceiptStatus.Done);
	});

	test('a confirming effect that fails externally resolves to Failed', async () => {
		const client = new FakeGitHubClient();
		client.nextEffect = { settled: false, externalRef: 'run-7' };
		const { executor } = create(client);
		const receipt = await executor.execute(ActionType.MergePr, { repo: 'acme/api', prNumber: 1, base: 'main', strategy: 'merge' }, 'k1');
		client.pollState = 'failed';
		const confirmed = await executor.confirm(receipt);
		assert.strictEqual(confirmed.status, ExecutorReceiptStatus.Failed);
		assert.ok(confirmed.failureReason);
	});

	test('confirm is a no-op while the effect is still pending', async () => {
		const client = new FakeGitHubClient();
		client.nextEffect = { settled: false, externalRef: 'run-7' };
		const { executor } = create(client);
		const receipt = await executor.execute(ActionType.MergePr, { repo: 'acme/api', prNumber: 1, base: 'main', strategy: 'merge' }, 'k1');
		client.pollState = 'pending';
		const still = await executor.confirm(receipt);
		assert.strictEqual(still.status, ExecutorReceiptStatus.Confirming);
	});

	test('a client write error becomes a Failed receipt with the reason', async () => {
		const client = new FakeGitHubClient();
		client.throwOn = ActionType.MergePr;
		const { executor } = create(client);
		const receipt = await executor.execute(ActionType.MergePr, { repo: 'acme/api', prNumber: 1, base: 'main', strategy: 'merge' }, 'k1');
		assert.strictEqual(receipt.status, ExecutorReceiptStatus.Failed);
		assert.ok(receipt.failureReason!.includes('github write failed'));
	});

	test('actionIdempotencyKey is stable and unique per action instance', () => {
		const a = actionIdempotencyKey('t1', 0, ActionType.MergePr, 'h1');
		const b = actionIdempotencyKey('t1', 0, ActionType.MergePr, 'h1');
		const c = actionIdempotencyKey('t1', 1, ActionType.MergePr, 'h1');
		assert.strictEqual(a, b);
		assert.notStrictEqual(a, c);
	});
});
