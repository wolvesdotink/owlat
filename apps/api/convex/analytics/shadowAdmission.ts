/**
 * D4, the shadow allowance, for the decisions lane (ADR-0073): one call
 * answers whether a shadowed task may judge a message now, and hands back
 * what its calls run under.
 *
 * - The task's switch must be at `shadow`, and the message must be inside the
 *   day's counted message quota (`aiRouting/shadowQuota.ts`; the hash in
 *   `lib/aiRouting/shadowSampling.ts` only picks candidates).
 * - The day's shadow allowance must have headroom, with a spend state that can
 *   be verified (`aiRouting/admission.ts` `headroom`, budget class `shadow`).
 * - Every call then runs as budget class `shadow` at background priority:
 *   `target` for `meterLlmCall`, `admission` for `runDecision` (with
 *   `lib/decision/ports.ts` `decisionUsageRecorder(ctx, { budgetClass: 'shadow' })`),
 *   so each dispatch reserves against the shadow allowance and its rows count
 *   there. A refusal at dispatch (another call took the allowance first) is an
 *   `AdmissionRefusedError`; the caller skips the shadow judgment.
 */

import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { taskPolicy } from '../lib/llm/taskPolicy';
import type { AdmissionPort } from '../lib/llm/admissionPort';
import type { LlmRootContext } from '../lib/llm/requestMeter';
import { shadowSample } from '../lib/aiRouting/shadowSampling';
import { dispatchAdmissionPort } from './admissionPorts';
import type { LlmSpendTarget } from './meteredSpend';

export type ShadowAdmission =
	| {
			readonly isAdmitted: true;
			readonly target: LlmSpendTarget;
			readonly admission: AdmissionPort | undefined;
	  }
	| {
			readonly isAdmitted: false;
			readonly why: 'not_shadowed' | 'not_sampled' | 'no_allowance';
	  };

export async function admitShadow(
	ctx: ActionCtx,
	args: {
		readonly task: AiTaskName;
		/** The message the judgment is about (its id): the sample is keyed on it. */
		readonly subjectKey: string;
		readonly feature: string;
		readonly root?: LlmRootContext;
	}
): Promise<ShadowAdmission> {
	const policy = await ctx.runQuery(internal.aiRouting.policy.getResolved, {});
	const sample = shadowSample(policy, args.task, args.subjectKey);
	if (!sample.isSampled && sample.why === 'not_shadowed')
		return { isAdmitted: false, why: 'not_shadowed' };
	// Every eligible message is counted; only a candidate inside the day's quota is admitted.
	const slot = await ctx.runMutation(internal.aiRouting.shadowQuota.claimShadowSlot, {
		task: args.task,
		subjectKey: args.subjectKey,
		isCandidate: sample.isSampled,
	});
	if (!slot.isAdmitted) return { isAdmitted: false, why: 'not_sampled' };
	const headroom = await ctx.runQuery(internal.aiRouting.admission.headroom, {
		plane: taskPolicy(args.task).plane,
		budgetClass: 'shadow',
		priority: 'background',
	});
	if (!headroom.isAdmitted) return { isAdmitted: false, why: 'no_allowance' };
	const shape = {
		budgetClass: 'shadow' as const,
		priority: 'background' as const,
		...(args.root ? { root: args.root } : {}),
	};
	return {
		isAdmitted: true,
		target: {
			feature: args.feature,
			task: args.task,
			policyVersion: policy.policyVersion,
			...shape,
		},
		admission: dispatchAdmissionPort(ctx, shape, args.task, args.root?.deadlineAt),
	};
}
