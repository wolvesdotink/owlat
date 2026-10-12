/**
 * D4, the shadow allowance: which messages a shadowed task may judge
 * (ADR-0073). Pure.
 *
 * Two limits apply, and both must allow a shadow call:
 *
 * 1. MESSAGES. At most `shadowMaxMessageFraction` of eligible messages (10% by
 *    default and at most). The sample is a deterministic function of the task
 *    and the message: an FNV-1a hash of `task|subjectKey` mapped onto [0, 1)
 *    must fall below the fraction. The same message is always in or out, a
 *    re-run cannot re-roll it, and over the id space exactly that share is in.
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

/** Limit 1 and the switch: may `task` shadow-judge the message `subjectKey`? */
export function shadowSample(
	policy: ResolvedRoutingPolicy,
	task: AiTaskName,
	subjectKey: string
): ShadowSampleVerdict {
	if (!isTaskShadowed(policy, task)) return { isSampled: false, why: 'not_shadowed' };
	return shadowSamplePoint(task, subjectKey) < policy.shadowMaxMessageFraction
		? { isSampled: true }
		: { isSampled: false, why: 'not_sampled' };
}
