/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { buildDistillerBrief, DISTILLER_SKILL_FENCE, parseProposedSkill } from '../common/distillerBrief.js';
import { IInboxOneFileStore, IStoredSkill } from '../common/inboxOneFileStore.js';
import { IExperienceRecord, LearningTarget } from '../common/learningLoop.js';
import { mapSessionStatusToEventType } from '../common/sessionEventMapping.js';
import { IInboxOneSessionLauncher } from './inboxOneSessionLauncher.js';
import { readSessionResponseText } from './sessionTranscriptReader.js';

/** Reconstructs an on-disk SKILL.md (frontmatter + body) so the distiller sees the full skill. */
function reconstructSkill(skill: IStoredSkill): string {
	const fm = skill.frontmatter;
	const lines = ['---', `id: ${fm.id}`];
	if (fm.roles.length) { lines.push(`roles: [${fm.roles.join(', ')}]`); }
	if (fm.transferScope) { lines.push(`transfer_scope: ${fm.transferScope}`); }
	if (fm.version !== undefined) { lines.push(`version: ${fm.version}`); }
	if (fm.provenance?.length) { lines.push(`provenance: [${fm.provenance.join(', ')}]`); }
	if (fm.triggers?.length) { lines.push(`triggers: [${fm.triggers.join(', ')}]`); }
	lines.push('---', '', skill.body);
	return lines.join('\n');
}

/**
 * The real semantic half of the learning loop (design 6.2): the `distillOne` hook
 * that dispatches a stock distiller AGENT session per resolution through the
 * central {@link IInboxOneSessionLauncher} (the same seam worker dispatch uses).
 * It briefs the session with the experience + current role skill, and when the
 * session completes reads its proposed SKILL.md from the chat model and applies
 * it as a new, versioned, rollbackable skill on the host. Deterministic
 * consolidation (wiki log + skill-impact) already ran in the orchestrator; this
 * adds the model authorship.
 *
 * Degrades gracefully when no session target is available: the launch returns
 * undefined, so nothing is written -- the deterministic ledger still advances.
 */
export class DistillerSessionDispatcher extends Disposable {

	constructor(
		@IInboxOneSessionLauncher private readonly launcher: IInboxOneSessionLauncher,
		@IInboxOneFileStore private readonly fileStore: IInboxOneFileStore,
		@IChatSessionsService private readonly chatSessions: IChatSessionsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/** Wire this as {@link LearningOrchestrator}'s `distillOne`. */
	readonly distill = async (record: IExperienceRecord, target: LearningTarget): Promise<void> => {
		const skill = await this.resolveTargetSkill(record, target);
		const brief = buildDistillerBrief(record, target, skill ? reconstructSkill(skill) : undefined);
		const session = await this.launcher.launch(brief, {
			title: 'Diffy distiller',
			activity: 'distiller',
			metadata: { inboxOneDistiller: record.resolutionId },
		});
		if (session && skill) {
			this.applyOnComplete(session, skill.frontmatter.id);
		}
	};

	/**
	 * Resolves the skill this target updates (design 6.2). Dismiss/rerank/snooze
	 * say "surfacing was wrong", so they teach Diffy's own coordinator
	 * priority/dispatch skill -- NOT the worker's role skill, which did nothing
	 * wrong. Accept/steer teach the role skill that produced the result.
	 */
	private async resolveTargetSkill(record: IExperienceRecord, target: LearningTarget): Promise<IStoredSkill | undefined> {
		const skills = await this.fileStore.listSkills();
		if (target === LearningTarget.CoordinatorSkill) {
			return skills.find(s => s.isCoordinator && !s.isFramework);
		}
		if (!record.role) {
			return undefined;
		}
		return skills.find(s => !s.isFramework && !s.isCoordinator && s.frontmatter.roles.includes(record.role!));
	}

	/** One-shot: when the distiller session finishes, read + apply its proposed skill. */
	private applyOnComplete(session: ISession, skillId: string): void {
		const watcher = new DisposableStore();
		watcher.add(autorun(reader => {
			const status = session.status.read(reader);
			if (mapSessionStatusToEventType(status) === 'task_finished') {
				watcher.dispose();
				this.apply(session, skillId).catch(err => this.logService.warn(`[inboxOne] distiller apply failed: ${err instanceof Error ? err.message : String(err)}`));
			}
		}));
		this._register(watcher);
	}

	private async apply(session: ISession, skillId: string): Promise<void> {
		const text = await readSessionResponseText(this.chatSessions, session.resource.toString(), '```' + DISTILLER_SKILL_FENCE, this.logService);
		const proposed = text ? parseProposedSkill(text) : undefined;
		if (!proposed) {
			this.logService.trace(`[inboxOne] distiller proposed no change to ${skillId}`);
			return;
		}
		await this.fileStore.writeSkill(skillId, proposed);
		this.logService.info(`[inboxOne] distiller updated skill ${skillId} (new version)`);
	}
}
