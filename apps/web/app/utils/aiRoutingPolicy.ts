/**
 * The AI routing policy panel's rules (ADR-0073, SPEC §3), as pure functions.
 *
 * The stored policy is `@owlat/shared/aiRouting`'s `ResolvedRoutingPolicy`. The
 * panel edits it as text fields (percentages, whole numbers, dollars) and a
 * select per switch, so this module turns one into the other and back:
 *
 *   - {@link routingPolicyFormOf}: the form a stored policy opens as;
 *   - {@link routingPolicyFormProblems}: what is wrong with the form, per field,
 *     as message KEYS. They mirror `routingPolicyProblem` on the server, which
 *     stays the authority; this only says it before the round trip;
 *   - {@link routingPolicyDraft}: the policy the form describes, for the live
 *     shadow-allowance preview;
 *   - {@link routingPolicyUpdateArgs}: the `aiRouting.policy.update` arguments,
 *     carrying only the fields that changed, so a save never rewrites a value
 *     the admin did not touch.
 *
 * Module scope, so nothing here translates: labels are catalog keys.
 */
import type { FunctionArgs } from 'convex/server';
import type { api } from '@owlat/api';
import {
	ROUTING_CAP_MAX,
	ROUTING_CAP_MIN,
	ROUTING_SWITCHES,
	ROUTING_SWITCH_KEYS,
	SHADOW_FRACTION_MAXIMA,
	resolveRoutingPolicy,
	shadowAllowanceUsd,
	type AiTaskName,
	type ResolvedRoutingPolicy,
	type RoutingSwitchKey,
} from '@owlat/shared/aiRouting';

export type RoutingPolicyUpdateArgs = FunctionArgs<typeof api.aiRouting.policy.update>;

const K = 'dashboard.admin.instance.aiProvider.routing';

/**
 * The one task whose prompt honours cache markers today (L9: interpretation,
 * `mail.extract`). The policy stores a list, but offering every language task
 * would offer switches that do nothing, so the panel shows this one and keeps
 * any other stored entry as it is.
 */
export const PROMPT_CACHE_TASK: AiTaskName = 'mail.extract';

/** The panel's groups, in reading order: the switches and caps of one area together. */
export const ROUTING_POLICY_GROUPS: readonly {
	key: 'team' | 'files' | 'decisions' | 'writing';
	switches: readonly RoutingSwitchKey[];
}[] = [
	{ key: 'team', switches: ['earlyRuleArchive', 'mtaVerdictTerminal'] },
	{ key: 'files', switches: ['attachmentGates'] },
	{
		key: 'decisions',
		switches: [
			'triageBundle',
			'categoryDisplayBundle',
			'dispositionAdvisoryBundle',
			'claimVerification',
			'clarifyNecessity',
		],
	},
	{ key: 'writing', switches: ['cheapFirstWriter', 'batchApi'] },
];

export interface RoutingPolicyForm {
	switches: Record<RoutingSwitchKey, string>;
	/** Whole number, or '' for no cap. */
	knowledgeEntryCap: string;
	verifyClaimCap: string;
	isInterpretationCached: boolean;
	/** Percent of the ceiling, as typed. */
	triagePercent: string;
	shadowMessagePercent: string;
	shadowCeilingPercent: string;
	/** Dollars, or '' for no cap. */
	shadowCapUsd: string;
}

export type RoutingPolicyField = Exclude<
	keyof RoutingPolicyForm,
	'switches' | 'isInterpretationCached'
>;

/** A translatable sentence: a key and its values. */
export interface RoutingPolicyText {
	key: string;
	params?: Record<string, string | number>;
}

/** A select option per value of a switch; the default value says so. */
export function routingSwitchOptions(key: RoutingSwitchKey): { value: string; label: string }[] {
	const spec = ROUTING_SWITCHES[key];
	return spec.values.map((value) => ({
		value,
		label: `${K}.values.${value === spec.defaultValue ? `${value}Default` : value}`,
	}));
}

/** A fraction as the percent the field shows: 0.1 → "10", 0.05 → "5". */
function percentOf(fraction: number): string {
	return String(Math.round(fraction * 1e6) / 1e4);
}

export function routingPolicyFormOf(policy: ResolvedRoutingPolicy): RoutingPolicyForm {
	const switches = Object.fromEntries(
		ROUTING_SWITCH_KEYS.map((key) => [key, policy[key]])
	) as Record<RoutingSwitchKey, string>;
	return {
		switches,
		knowledgeEntryCap: policy.knowledgeEntryCapPerMessage?.toString() ?? '',
		verifyClaimCap: policy.verifyClaimCapPerMessage?.toString() ?? '',
		isInterpretationCached: policy.promptCacheTasks.includes(PROMPT_CACHE_TASK),
		triagePercent: percentOf(policy.triageAllowanceFraction),
		shadowMessagePercent: percentOf(policy.shadowMaxMessageFraction),
		shadowCeilingPercent: percentOf(policy.shadowMaxCeilingFraction),
		shadowCapUsd: policy.shadowCapUsd?.toString() ?? '',
	};
}

/** A typed number, or null for an empty field, or NaN for anything else. */
function parseNumber(raw: string): number | null {
	const text = raw.trim().replace(',', '.');
	if (!text) return null;
	return /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
}

function capProblem(raw: string): RoutingPolicyText | null {
	const value = parseNumber(raw);
	if (value === null) return null;
	if (!Number.isInteger(value) || value < ROUTING_CAP_MIN || value > ROUTING_CAP_MAX) {
		return { key: `${K}.problems.cap`, params: { min: ROUTING_CAP_MIN, max: ROUTING_CAP_MAX } };
	}
	return null;
}

function percentProblem(raw: string, maxPercent: number, inclusiveMax: boolean) {
	const value = parseNumber(raw);
	const isValid =
		value !== null &&
		Number.isFinite(value) &&
		value > 0 &&
		(inclusiveMax ? value <= maxPercent : value < maxPercent);
	if (isValid) return null;
	return inclusiveMax
		? { key: `${K}.problems.percentUpTo`, params: { max: maxPercent } }
		: { key: `${K}.problems.percentBelow`, params: { max: maxPercent } };
}

/** Whether any switch in the form is set to `shadow`. */
export function isAnyShadowed(form: RoutingPolicyForm): boolean {
	return ROUTING_SWITCH_KEYS.some((key) => form.switches[key] === 'shadow');
}

/**
 * What is wrong with the form, per field. Empty when it can be saved. The
 * cross-field rule (D4): with no daily ceiling, shadowing needs a finite cap.
 */
export function routingPolicyFormProblems(
	form: RoutingPolicyForm,
	context: { dailyCeilingUsd: number }
): Partial<Record<RoutingPolicyField, RoutingPolicyText>> {
	const problems: Partial<Record<RoutingPolicyField, RoutingPolicyText>> = {};
	const knowledge = capProblem(form.knowledgeEntryCap);
	if (knowledge) problems.knowledgeEntryCap = knowledge;
	const verify = capProblem(form.verifyClaimCap);
	if (verify) problems.verifyClaimCap = verify;
	const triage = percentProblem(form.triagePercent, 100, false);
	if (triage) problems.triagePercent = triage;
	const message = percentProblem(
		form.shadowMessagePercent,
		SHADOW_FRACTION_MAXIMA.shadowMaxMessageFraction * 100,
		true
	);
	if (message) problems.shadowMessagePercent = message;
	const ceiling = percentProblem(
		form.shadowCeilingPercent,
		SHADOW_FRACTION_MAXIMA.shadowMaxCeilingFraction * 100,
		true
	);
	if (ceiling) problems.shadowCeilingPercent = ceiling;
	const cap = parseNumber(form.shadowCapUsd);
	if (cap !== null && !(Number.isFinite(cap) && cap > 0)) {
		problems.shadowCapUsd = { key: `${K}.problems.usd` };
	} else if (cap === null && isAnyShadowed(form) && !(context.dailyCeilingUsd > 0)) {
		problems.shadowCapUsd = { key: `${K}.problems.shadowCapRequired` };
	}
	return problems;
}

function fractionOf(raw: string, fallback: number): number {
	const value = parseNumber(raw);
	return value !== null && Number.isFinite(value) ? value / 100 : fallback;
}

function wholeOrNull(raw: string, fallback: number | null): number | null {
	const value = parseNumber(raw);
	if (value === null) return null;
	return Number.isFinite(value) ? value : fallback;
}

/** The cache list the form describes: the stored list with the one offered task toggled. */
function cacheTasksOf(form: RoutingPolicyForm, stored: ResolvedRoutingPolicy): AiTaskName[] {
	const others = stored.promptCacheTasks.filter((task) => task !== PROMPT_CACHE_TASK);
	return form.isInterpretationCached ? [...others, PROMPT_CACHE_TASK] : others;
}

/** The policy the form describes (an unparsable field keeps its stored value). */
export function routingPolicyDraft(
	form: RoutingPolicyForm,
	stored: ResolvedRoutingPolicy
): ResolvedRoutingPolicy {
	return resolveRoutingPolicy({
		...form.switches,
		policyVersion: stored.policyVersion,
		knowledgeEntryCapPerMessage:
			wholeOrNull(form.knowledgeEntryCap, stored.knowledgeEntryCapPerMessage) ?? undefined,
		verifyClaimCapPerMessage:
			wholeOrNull(form.verifyClaimCap, stored.verifyClaimCapPerMessage) ?? undefined,
		promptCacheTasks: cacheTasksOf(form, stored),
		triageAllowanceFraction: fractionOf(form.triagePercent, stored.triageAllowanceFraction),
		shadowMaxMessageFraction: fractionOf(
			form.shadowMessagePercent,
			stored.shadowMaxMessageFraction
		),
		shadowMaxCeilingFraction: fractionOf(
			form.shadowCeilingPercent,
			stored.shadowMaxCeilingFraction
		),
		shadowCapUsd: wholeOrNull(form.shadowCapUsd, stored.shadowCapUsd) ?? undefined,
		...(stored.updatedAt !== null ? { updatedAt: stored.updatedAt } : {}),
	});
}

/** What shadow runs may spend a day under the form, in USD (D4). */
export function draftShadowAllowanceUsd(
	form: RoutingPolicyForm,
	stored: ResolvedRoutingPolicy,
	dailyCeilingUsd: number
): number {
	return shadowAllowanceUsd(routingPolicyDraft(form, stored), dailyCeilingUsd);
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * The `update` arguments for the fields the form changed, or null when nothing
 * changed. A cleared cap travels as `null`, which the server reads as "unset".
 */
export function routingPolicyUpdateArgs(
	form: RoutingPolicyForm,
	stored: ResolvedRoutingPolicy
): RoutingPolicyUpdateArgs | null {
	const draft = routingPolicyDraft(form, stored);
	const args: Record<string, unknown> = {};
	for (const key of ROUTING_SWITCH_KEYS) {
		if (draft[key] !== stored[key]) args[key] = draft[key];
	}
	for (const key of [
		'knowledgeEntryCapPerMessage',
		'verifyClaimCapPerMessage',
		'shadowCapUsd',
	] as const) {
		if (draft[key] !== stored[key]) args[key] = draft[key];
	}
	for (const key of [
		'triageAllowanceFraction',
		'shadowMaxMessageFraction',
		'shadowMaxCeilingFraction',
	] as const) {
		if (!sameNumber(draft[key], stored[key])) args[key] = draft[key];
	}
	const cacheTasks = cacheTasksOf(form, stored);
	if (cacheTasks.join() !== stored.promptCacheTasks.join()) args['promptCacheTasks'] = cacheTasks;
	if (Object.keys(args).length === 0) return null;
	return { expectedPolicyVersion: stored.policyVersion, ...args } as RoutingPolicyUpdateArgs;
}
