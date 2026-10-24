/**
 * The AI routing policy panel's rules, as pure functions.
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
import type { LocalizedText } from '~/utils/localizedText';
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
	type RoutingPolicyRow,
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

/** A field problem: a catalog key with the values it names. */
export type RoutingPolicyText = Extract<LocalizedText, { key: string }>;

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
 * What is wrong with the form, per field. Empty when it can be saved.
 *
 * Only an EDITED field is read as typed. With `opened` (the form the stored
 * policy opened as), a field whose text is unchanged stands for its stored
 * value, which the server already accepted and a save leaves as it is: a
 * stored triage share of 0.9999999 shows as "100" and 0.0000001 as "0", and
 * neither may block saving another field. The cross-field rule always
 * applies: with no daily ceiling, shadowing needs a finite cap.
 */
export function routingPolicyFormProblems(
	form: RoutingPolicyForm,
	context: { dailyCeilingUsd: number; opened?: RoutingPolicyForm }
): Partial<Record<RoutingPolicyField, RoutingPolicyText>> {
	const problems: Partial<Record<RoutingPolicyField, RoutingPolicyText>> = {};
	const isEdited = (field: RoutingPolicyField) =>
		!context.opened || form[field] !== context.opened[field];
	const check = (
		field: RoutingPolicyField,
		problemOf: (raw: string) => RoutingPolicyText | null
	) => {
		const problem = isEdited(field) ? problemOf(form[field]) : null;
		if (problem) problems[field] = problem;
	};
	check('knowledgeEntryCap', capProblem);
	check('verifyClaimCap', capProblem);
	check('triagePercent', (raw) => percentProblem(raw, 100, false));
	check('shadowMessagePercent', (raw) =>
		percentProblem(raw, SHADOW_FRACTION_MAXIMA.shadowMaxMessageFraction * 100, true)
	);
	check('shadowCeilingPercent', (raw) =>
		percentProblem(raw, SHADOW_FRACTION_MAXIMA.shadowMaxCeilingFraction * 100, true)
	);
	const cap = parseNumber(form.shadowCapUsd);
	if (isEdited('shadowCapUsd') && cap !== null && !(Number.isFinite(cap) && cap > 0)) {
		problems.shadowCapUsd = { key: `${K}.problems.usd` };
	} else if (cap === null && isAnyShadowed(form) && !(context.dailyCeilingUsd > 0)) {
		problems.shadowCapUsd = { key: `${K}.problems.shadowCapRequired` };
	}
	return problems;
}

/** The text fields, the policy field each edits, and how its text reads. */
const NUMERIC_FIELDS = [
	{ field: 'knowledgeEntryCap', key: 'knowledgeEntryCapPerMessage', isPercent: false },
	{ field: 'verifyClaimCap', key: 'verifyClaimCapPerMessage', isPercent: false },
	{ field: 'shadowCapUsd', key: 'shadowCapUsd', isPercent: false },
	{ field: 'triagePercent', key: 'triageAllowanceFraction', isPercent: true },
	{ field: 'shadowMessagePercent', key: 'shadowMaxMessageFraction', isPercent: true },
	{ field: 'shadowCeilingPercent', key: 'shadowMaxCeilingFraction', isPercent: true },
] as const;

type NumericKey = (typeof NUMERIC_FIELDS)[number]['key'];

/** The policy fields a form edit changed, as the values a save sends (`null` clears). */
type RoutingPolicyChanges = Partial<
	Pick<ResolvedRoutingPolicy, RoutingSwitchKey | NumericKey | 'promptCacheTasks'>
>;

const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * What the admin changed, against the policy the form opened from (`base`).
 *
 * A field whose text still reads as it opened is untouched, and its stored
 * value stays exactly as it is: a percentage is shown rounded, so reading it
 * back would move 0.123456789 to 0.123457, and the cache list keeps its order.
 * An edited field that cannot be read is left out too; its problem blocks the
 * save. An edit back to the stored value is no change.
 */
function routingPolicyChanges(
	form: RoutingPolicyForm,
	base: ResolvedRoutingPolicy
): RoutingPolicyChanges {
	const opened = routingPolicyFormOf(base);
	const changes: Record<string, unknown> = {};
	for (const key of ROUTING_SWITCH_KEYS) {
		if (form.switches[key] !== base[key]) changes[key] = form.switches[key];
	}
	for (const { field, key, isPercent } of NUMERIC_FIELDS) {
		if (form[field] === opened[field]) continue;
		const value = parseNumber(form[field]);
		if (value !== null && !Number.isFinite(value)) continue;
		if (value === null && isPercent) continue;
		const next = value === null ? null : isPercent ? value / 100 : value;
		const before = base[key];
		const isSame = next === null || before === null ? next === before : sameNumber(next, before);
		if (!isSame) changes[key] = next;
	}
	if (form.isInterpretationCached !== opened.isInterpretationCached) {
		changes['promptCacheTasks'] = form.isInterpretationCached
			? [...base.promptCacheTasks, PROMPT_CACHE_TASK]
			: base.promptCacheTasks.filter((task) => task !== PROMPT_CACHE_TASK);
	}
	return changes as RoutingPolicyChanges;
}

/** The policy the form describes: the base with the admin's changes applied. */
export function routingPolicyDraft(
	form: RoutingPolicyForm,
	base: ResolvedRoutingPolicy
): ResolvedRoutingPolicy {
	const merged: Record<string, unknown> = { ...base, ...routingPolicyChanges(form, base) };
	// A row reads an absent field as unset, never `null`.
	for (const [key, value] of Object.entries(merged)) {
		if (value === null) delete merged[key];
	}
	return resolveRoutingPolicy(merged as RoutingPolicyRow);
}

/** What shadow runs may spend a day under the form, in USD. */
export function draftShadowAllowanceUsd(
	form: RoutingPolicyForm,
	base: ResolvedRoutingPolicy,
	dailyCeilingUsd: number
): number {
	return shadowAllowanceUsd(routingPolicyDraft(form, base), dailyCeilingUsd);
}

/**
 * The `update` arguments for the fields the form changed, or null when nothing
 * changed. `base` is the policy the form was opened from, and its version is
 * the one the save expects: if another admin saved since, the server refuses
 * with a conflict instead of this save reverting their change.
 */
export function routingPolicyUpdateArgs(
	form: RoutingPolicyForm,
	base: ResolvedRoutingPolicy
): RoutingPolicyUpdateArgs | null {
	const changes = routingPolicyChanges(form, base);
	if (Object.keys(changes).length === 0) return null;
	return { expectedPolicyVersion: base.policyVersion, ...changes } as RoutingPolicyUpdateArgs;
}
