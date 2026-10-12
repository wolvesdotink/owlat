/**
 * The applied-decision gate (ADR-0073 §8 and its auto-send contract; clarify
 * lane, Sol r3 F3): a Phase 3 decision verdict that DECIDED part of this
 * message's handling (an enforced claim check applied to its interpretation,
 * an enforced necessity judgment that settled its clarification) may let the
 * message auto-send only if the auto-send contract admits it
 * (`lib/decision/autoSendContract.ts admitVerdictScore`): its task feeds
 * auto-send, item coverage is enforced, and it passes the provenance and
 * calibration rule. Otherwise the verdict may change what is shown, and the
 * send waits for a person.
 *
 * Block-only, and it touches no score. Nothing feeds auto-send in this
 * release (`AUTO_SEND_VERDICT_TASKS` is empty), so any applied Phase 3
 * verdict holds the send. Off and shadow are inert: they leave no applied
 * (advisory) artifact, and the gate reads only advisory ones.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import { internal } from '../../../_generated/api';
import {
	AUTO_SEND_VERDICT_TASKS,
	CALIBRATION_REVISIONS,
	verdictBlockReason,
	type StoredVerdict,
} from '../../../lib/decision/calibration';
import { admitVerdictScore, decisionAutonomyProblem } from '../../../lib/decision/autoSendContract';
import type { AutoSendGateContext, AutoSendGateDecision, CoreAutoSendGate } from './autoSendGates';

/** The Phase 3 tasks whose enforced verdicts are applied to a Team message's handling. */
export const APPLIED_DECISION_TASKS: readonly AiTaskName[] = ['mail.claim_check', 'mail.necessity'];

const safe = (): AutoSendGateDecision => Object.freeze({ safe: true });
const unsafe = (reason: string): AutoSendGateDecision => Object.freeze({ safe: false, reason });

/** Why the contract refuses an applied verdict (the first rule it fails). */
function refusalOf(
	verdict: StoredVerdict,
	context: Parameters<typeof admitVerdictScore>[2] & { verdictTasks: readonly AiTaskName[] }
): string {
	if (!context.verdictTasks.includes(verdict.task)) return 'its task does not feed auto-send';
	const prerequisite = decisionAutonomyProblem(context);
	if (prerequisite) return prerequisite;
	return verdictBlockReason(verdict, context) ?? 'the auto-send contract refused it';
}

export function appliedDecisionGate(
	tasks: readonly AiTaskName[] = APPLIED_DECISION_TASKS,
	verdictTasks: readonly AiTaskName[] = AUTO_SEND_VERDICT_TASKS,
	registry: typeof CALIBRATION_REVISIONS = CALIBRATION_REVISIONS
): CoreAutoSendGate {
	return Object.freeze({
		id: 'applied_decision',
		async evaluate({ action, inboundMessageId, now }: AutoSendGateContext) {
			const inputs = await action.runQuery(internal.decision.context.appliedVerdictInputs, {
				inboundMessageId,
				tasks: [...tasks],
			});
			if (inputs.isTruncated) {
				return unsafe('Too many decision verdicts to check; routing to human review.');
			}
			if (inputs.applied.length === 0 || !inputs.current) return safe();
			const decisionConfigIdentity = await action.runAction(
				internal.decision.planeIdentity.resolvedIdentity,
				{ isDecisionPlaneOn: inputs.current.isDecisionPlaneOn }
			);
			const context = {
				policyVersion: inputs.current.policyVersion,
				language: inputs.current.language,
				decisionConfigIdentity,
				now: now(),
				registry,
				isItemCoverageEnforced: inputs.isItemCoverageEnforced,
				verdictTasks,
			};
			for (const verdict of inputs.applied) {
				// The contract's one entry; a full score lowers nothing even when admitted.
				if (admitVerdictScore(verdict, 1, context) !== null) continue;
				return unsafe(
					`A ${verdict.task} decision verdict decided part of this message's handling but cannot let it auto-send: ${refusalOf(verdict, context)}. Routing to human review.`
				);
			}
			return safe();
		},
	});
}
