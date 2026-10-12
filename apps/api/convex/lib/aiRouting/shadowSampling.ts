/**
 * D4, the shadow allowance: which messages a shadowed task may judge
 * (ADR-0073). Pure.
 *
 * Two limits apply, and both must allow a shadow call:
 *
 * 1. MESSAGES. At most `shadowMaxMessageFraction` of a task's eligible
 *    messages per UTC day (10% by default and at most). That limit is COUNTED
 *    (`aiRouting/shadowQuota.ts`): a message is admitted only while admitted
 *    + 1 ≤ floor(share × eligible). The hash here only chooses candidates: an
 *    FNV-1a of `task|subjectKey` mapped onto [0, 1) below twice the share, so
 *    the quota is spread over the day and a re-run cannot re-roll a message.
 * 2. MONEY. The day's shadow spend stays within `shadowAllowanceUsd` (the
 *    smaller of `shadowMaxCeilingFraction` of the daily ceiling and
 *    `shadowCapUsd`; zero without either). That is enforced at dispatch by
 *    admission, for every call whose budget class is `shadow`
 *    (`lib/aiRouting/admissionRules.ts`, rule 5).
 *
 * A task is shadowed only while its routing switch is at `shadow`: off by
 * default, enabled per task.
 */

import {
	ROUTING_SWITCHES,
	ROUTING_SWITCH_KEYS,
	type AiTaskName,
	type ResolvedRoutingPolicy,
} from '@owlat/shared/aiRouting';

/** 32-bit FNV-1a over the UTF-16 code units. Stable across runtimes. */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/** Where `task|subjectKey` falls in [0, 1). */
export function shadowSamplePoint(task: AiTaskName, subjectKey: string): number {
	return fnv1a(`${task}|${subjectKey}`) / 0x1_0000_0000;
}

/** Whether a routing switch whose task is `task` is set to `shadow`. */
export function isTaskShadowed(policy: ResolvedRoutingPolicy, task: AiTaskName): boolean {
	return ROUTING_SWITCH_KEYS.some((key) => {
		const definition = ROUTING_SWITCHES[key] as { readonly task?: AiTaskName };
		return definition.task === task && (policy[key] as string) === 'shadow';
	});
}

export type ShadowSampleVerdict =
	| { readonly isSampled: true }
	| { readonly isSampled: false; readonly why: 'not_shadowed' | 'not_sampled' };

/** Candidates are drawn at this multiple of the share; the counted quota caps the admitted. */
export const CANDIDATE_OVERSAMPLE = 2;

/** The switch, and whether the hash makes `subjectKey` a candidate for `task`'s quota. */
export function shadowSample(
	policy: ResolvedRoutingPolicy,
	task: AiTaskName,
	subjectKey: string
): ShadowSampleVerdict {
	if (!isTaskShadowed(policy, task)) return { isSampled: false, why: 'not_shadowed' };
	return shadowSamplePoint(task, subjectKey) <
		Math.min(1, CANDIDATE_OVERSAMPLE * policy.shadowMaxMessageFraction)
		? { isSampled: true }
		: { isSampled: false, why: 'not_sampled' };
}
