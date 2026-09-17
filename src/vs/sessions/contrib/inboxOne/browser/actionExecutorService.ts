/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ACTION_CATALOG, IActionPayloads, validateAction } from '../common/actionCatalog.js';
import { IActionExecutor, IExternalEffect, IGitHubWriteClient } from '../common/actionExecutor.js';
import { ActionType, ExecutorReceiptStatus, IExecutorReceipt } from '../common/inboxOneTypes.js';

/**
 * {@link IActionExecutor} backed by a typed GitHub write client. It is the ONLY
 * path to a repository write (design 7.3): it host-validates the payload against
 * the catalog, executes with an idempotency key, and resolves async effects by
 * reading GitHub state. `dispatch_fix` is not a repo write here -- it opens child
 * work -- so it is rejected by the executor and handled by the coordinator.
 */
export class ActionExecutorService implements IActionExecutor {

	declare readonly _serviceBrand: undefined;

	/** Idempotency memo: a repeated key returns the original receipt (I2). */
	private readonly receipts = new Map<string, IExecutorReceipt>();

	constructor(
		private readonly client: IGitHubWriteClient,
		private readonly logService: ILogService,
	) { }

	async execute<T extends ActionType>(actionType: T, payload: IActionPayloads[T], idempotencyKey: string): Promise<IExecutorReceipt> {
		// Idempotent: a retried execute with the same key never double-applies.
		const existing = this.receipts.get(idempotencyKey);
		if (existing) {
			return existing;
		}

		// Host validation: reject out-of-catalog or malformed payloads. Never execute.
		const validation = validateAction(actionType, payload);
		if (!validation.valid) {
			return this.fail(actionType, payload, idempotencyKey, validation.problems.join('; '));
		}
		// dispatch_fix opens child Cooking work, not a repo write -- the coordinator
		// handles it, so the executor declines it explicitly.
		if (!ACTION_CATALOG[actionType].writesRepo) {
			return this.fail(actionType, payload, idempotencyKey, `${actionType} is not a repository write`);
		}

		let effect: IExternalEffect;
		try {
			effect = await this.performWrite(actionType, payload);
		} catch (err) {
			return this.fail(actionType, payload, idempotencyKey, err instanceof Error ? err.message : String(err));
		}

		const receipt: IExecutorReceipt = {
			id: generateUuid(),
			actionType,
			payload,
			idempotencyKey,
			externalRef: effect.externalRef,
			status: effect.failureReason ? ExecutorReceiptStatus.Failed
				: effect.settled ? ExecutorReceiptStatus.Done
					: ExecutorReceiptStatus.Confirming,
			failureReason: effect.failureReason,
		};
		this.receipts.set(idempotencyKey, receipt);
		this.logService.info(`[inboxOne] executor ${actionType} -> ${receipt.status}`);
		return receipt;
	}

	async confirm(receipt: IExecutorReceipt): Promise<IExecutorReceipt> {
		if (receipt.status !== ExecutorReceiptStatus.Confirming || !receipt.externalRef) {
			return receipt;
		}
		// Resolve by READING external state, never by assuming.
		const state = await this.client.pollEffect(receipt.externalRef);
		if (state === 'pending') {
			return receipt;
		}
		const resolved: IExecutorReceipt = {
			...receipt,
			status: state === 'done' ? ExecutorReceiptStatus.Done : ExecutorReceiptStatus.Failed,
			failureReason: state === 'failed' ? 'external effect failed' : undefined,
		};
		this.receipts.set(receipt.idempotencyKey, resolved);
		return resolved;
	}

	private performWrite<T extends ActionType>(actionType: T, payload: IActionPayloads[T]): Promise<IExternalEffect> {
		switch (actionType) {
			case ActionType.MergePr: return this.client.mergePr(payload as IActionPayloads[ActionType.MergePr]);
			case ActionType.ApprovePr: return this.client.approvePr(payload as IActionPayloads[ActionType.ApprovePr]);
			case ActionType.CreatePr: return this.client.createPr(payload as IActionPayloads[ActionType.CreatePr]);
			case ActionType.Comment: return this.client.comment(payload as IActionPayloads[ActionType.Comment]);
			case ActionType.AddLabels: return this.client.addLabels(payload as IActionPayloads[ActionType.AddLabels]);
			case ActionType.CreateIssues: return this.client.createIssues(payload as IActionPayloads[ActionType.CreateIssues]);
			case ActionType.Deploy: return this.client.deploy(payload as IActionPayloads[ActionType.Deploy]);
			case ActionType.GrantScope: return this.client.grantScope(payload as IActionPayloads[ActionType.GrantScope]);
			default: return Promise.reject(new Error(`no write handler for ${actionType}`));
		}
	}

	private fail(actionType: ActionType, payload: unknown, idempotencyKey: string, reason: string): IExecutorReceipt {
		const receipt: IExecutorReceipt = {
			id: generateUuid(),
			actionType,
			payload,
			idempotencyKey,
			status: ExecutorReceiptStatus.Failed,
			failureReason: reason,
		};
		this.receipts.set(idempotencyKey, receipt);
		this.logService.warn(`[inboxOne] executor rejected ${actionType}: ${reason}`);
		return receipt;
	}
}

/** Builds the idempotency key for an action (technical spec 7). */
export function actionIdempotencyKey(taskId: string, attemptIndex: number, actionType: ActionType, payloadHash: string): string {
	return `${taskId}:${attemptIndex}:${actionType}:${payloadHash}`;
}
