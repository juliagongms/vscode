/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IActionPayloads } from './actionCatalog.js';
import { ActionType, IExecutorReceipt } from './inboxOneTypes.js';

export const IActionExecutor = createDecorator<IActionExecutor>('inboxOneActionExecutor');

/**
 * The typed Action Executor (design 7.3, technical spec 7). All repository
 * writes go through this fixed catalog. The model proposes a payload; the
 * executor validates it against the schema, performs the write with an
 * idempotency key, and returns a receipt. Async effects enter `confirming` and
 * are resolved by READING GitHub state (never by assuming). A retried confirm
 * never double-applies (I2).
 */
export interface IActionExecutor {
	readonly _serviceBrand: undefined;

	/**
	 * Validates and executes a typed action. Rejects out-of-catalog or malformed
	 * payloads (never executes them). Returns a receipt; `confirming` receipts are
	 * resolved later via {@link confirm}.
	 */
	execute<T extends ActionType>(actionType: T, payload: IActionPayloads[T], idempotencyKey: string): Promise<IExecutorReceipt>;

	/** Resolves a `confirming` receipt by reading external state. Idempotent. */
	confirm(receipt: IExecutorReceipt): Promise<IExecutorReceipt>;
}

/**
 * The minimal GitHub write surface the executor needs. Backed by the real GitHub
 * models in production; a fake in tests. Each method is idempotent given the same
 * inputs and returns an external ref where an async effect must be confirmed.
 */
export interface IGitHubWriteClient {
	mergePr(payload: IActionPayloads[ActionType.MergePr]): Promise<IExternalEffect>;
	approvePr(payload: IActionPayloads[ActionType.ApprovePr]): Promise<IExternalEffect>;
	createPr(payload: IActionPayloads[ActionType.CreatePr]): Promise<IExternalEffect>;
	comment(payload: IActionPayloads[ActionType.Comment]): Promise<IExternalEffect>;
	addLabels(payload: IActionPayloads[ActionType.AddLabels]): Promise<IExternalEffect>;
	createIssues(payload: IActionPayloads[ActionType.CreateIssues]): Promise<IExternalEffect>;
	deploy(payload: IActionPayloads[ActionType.Deploy]): Promise<IExternalEffect>;
	grantScope(payload: IActionPayloads[ActionType.GrantScope]): Promise<IExternalEffect>;
	/** Reads whether a previously-started async effect has settled (confirm path). */
	pollEffect(externalRef: string): Promise<'pending' | 'done' | 'failed'>;
}

export interface IExternalEffect {
	/** Whether the effect is immediately settled (sync) or must be confirmed (async). */
	readonly settled: boolean;
	readonly externalRef?: string;
	/** For a synchronously-failed write. */
	readonly failureReason?: string;
}

export const enum ExecutorRejectionReason {
	OutOfCatalog = 'out_of_catalog',
	MalformedPayload = 'malformed_payload',
	NotWriteAction = 'not_write_action',
}
