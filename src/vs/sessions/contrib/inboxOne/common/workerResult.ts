/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRawWorkerResult } from './emitResult.js';
import { ILogicalTask } from './inboxOneTypes.js';
import { parseWorkerResult, deriveRankSignals } from './parseWorkerResult.js';
import { IRankSignals } from './ranking.js';

/**
 * Reads the structured result a finished worker session emitted (technical spec
 * 2.3, 7.1). The worker follows the baked-in emit-result contract and, as its
 * final step, produces the raw {@link IRawWorkerResult} (typed action + label +
 * evidence pack). Parsing that structured output from a real session transcript /
 * tool call is provider-specific, so it lives behind this seam; the coordinator
 * engine consumes {@link IWorkerOutput} without any session-runtime coupling.
 *
 * The host -- not the model -- also derives the ranking {@link IRankSignals} from
 * real world/session state (who is blocked, ownership, freshness), so the tier
 * and the plain-language rank reason are computed, never authored by the worker.
 */
export interface IWorkerOutput {
	/** The untrusted raw result the worker emitted; the host validates it. */
	readonly result: IRawWorkerResult;
	/** Host-derived ranking signals from real world/session state. */
	readonly signals: IRankSignals;
}

/**
 * The outcome of reading a worker's transcript tail. `output` is present only
 * when a parseable emit-result was found. `hadContent` reports whether the worker
 * produced ANY final assistant text at all -- the engine uses this to tell a
 * genuine "finished with prose but no result block" (nudge/land-unfinished) apart
 * from an EMPTY read (the session went idle between turns / completed prematurely,
 * so we must keep waiting rather than give up).
 */
export interface IWorkerReadResult {
	readonly output?: IWorkerOutput;
	readonly hadContent: boolean;
}

export interface IWorkerResultReader {
	/**
	 * Reads the emitted result for a worker session. Never throws. `output` is set
	 * only when a parseable emit-result was found; `hadContent` says whether the
	 * worker produced any final text (so the caller can distinguish an empty/idle
	 * read from a real result-less finish).
	 */
	read(task: ILogicalTask, sessionRef: string): Promise<IWorkerReadResult>;
}

/**
 * Provides the final assistant message of a worker session (its transcript tail),
 * from which the emit-result block is parsed. Reading a real session transcript is
 * provider-specific, so it lives behind this seam; the reader logic is pure.
 */
export interface ITranscriptSource {
	readFinalMessage(task: ILogicalTask, sessionRef: string): Promise<string | undefined>;
}

/**
 * The {@link IWorkerResultReader} that turns a worker's final message into a
 * validated-upstream {@link IWorkerOutput}: it reads the transcript tail via an
 * {@link ITranscriptSource}, parses the emit-result block, and derives the
 * host-authoritative ranking signals. Pure and unit-testable; only the transcript
 * source is host-specific.
 */
export class TranscriptWorkerResultReader implements IWorkerResultReader {
	constructor(private readonly source: ITranscriptSource) { }

	async read(task: ILogicalTask, sessionRef: string): Promise<IWorkerReadResult> {
		const text = await this.source.readFinalMessage(task, sessionRef);
		if (!text || !text.trim()) {
			return { hadContent: false };
		}
		const result = parseWorkerResult(text);
		if (!result) {
			return { hadContent: true };
		}
		return { output: { result, signals: deriveRankSignals(result, task) }, hadContent: true };
	}
}
