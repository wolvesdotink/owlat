/**
 * AI routing: the vocabulary the backend and the web app share (ADR-0073).
 *
 * Three things live here, so the settings form, the Convex validators and the
 * code that reads the policy cannot drift apart:
 *
 *   - the task names of the task-policy catalog (`AI_TASK_NAMES`). The backend
 *     catalog (`apps/api/convex/lib/llm/taskPolicy.ts`) gives each one its
 *     plane, tiers, limits and fallback; this file only names them;
 *   - the routing-policy switches (`ROUTING_SWITCHES`) and the numeric settings
 *     beside them, with their defaults. A missing stored row means these
 *     defaults, and the defaults are today's behaviour (SPEC §2);
 *   - the small enums the new records store and the UI renders: why the model
 *     guard did not run, why a message waits for a human after the ceiling,
 *     where an embedding space's provenance came from, the re-embed job state.
 *
 * Everything here is pure. `resolveRoutingPolicy` turns a stored row (or no
 * row) into a complete typed policy; `routingPolicyProblem` says what is wrong
 * with one before it is saved.
 */

// ── Task names ────────────────────────────────────────────────────────────

/**
 * Every task the routing policy knows. Dotted `<surface>.<job>`; the plan's
 * names (`mail.classify`, `mail.extract`, `mail.verify`, `mail.clarify`,
 * `mail.draft`, `assistant.answer`) plus the rest of today's call sites and the
 * decision bundles the later phases add. Append only: the ledger stores these
 * strings, so a rename is a migration.
 */
export const AI_TASK_NAMES = [
	// Language plane, Team Inbox and Postbox pipelines
	'mail.guard',
	'mail.classify',
	'mail.extract',
	'mail.verify',
	'mail.clarify',
	'mail.draft',
	'mail.draft_check',
	'mail.outcome_sentiment',
	'mail.voice_profile',
	// Language plane, interactive Postbox features
	'mail.compose',
	'mail.plan_coverage',
	'mail.suggest',
	'mail.complete',
	'mail.ask',
	'mail.rewrite',
	'mail.coach',
	'mail.translate',
	'mail.rule_compile',
	// Language plane, knowledge, files, assistant, analytics, plugins
	'knowledge.extract',
	'knowledge.relate',
	'file.summarize',
	'assistant.answer',
	'assistant.tool_draft',
	'assistant.quick_query',
	'analytics.visualize',
	'analytics.visualize_title',
	'plugin.invoke',
	// Decision plane (the `llm` adapter answers these on the fast tier)
	'decision.connection_probe',
	'mail.triage',
	'mail.category',
	'mail.disposition',
	'mail.claim_check',
	'mail.necessity',
	'mail.draft_quality',
	// Embedding plane
	'embedding.index',
	'embedding.query',
] as const;

export type AiTaskName = (typeof AI_TASK_NAMES)[number];

const TASK_NAME_SET: ReadonlySet<string> = new Set(AI_TASK_NAMES);

/** Whether a string is one of {@link AI_TASK_NAMES}. */
export function isAiTaskName(value: string): value is AiTaskName {
	return TASK_NAME_SET.has(value);
}

// ── Routing-policy switches ───────────────────────────────────────────────

interface RoutingSwitchSpec {
	/** The values the switch takes; the first is always the off value. */
	readonly values: readonly [string, ...string[]];
	readonly defaultValue: string;
	/** The task whose spend a `shadow` value draws from the shadow allowance. */
	readonly task?: AiTaskName;
}

/**
 * The behaviour switches of SPEC §2's "off or shadow" list. Each one defaults
 * to today's behaviour. `off` keeps today's path; `shadow` runs the new path
 * beside it and records what it would have done, inside the shadow allowance;
 * `enforce` (or the task-specific value) makes the new path live.
 */
export const ROUTING_SWITCHES = {
	/** L4: handling rules with no category facet run before retrieval and classify. */
	earlyRuleArchive: { values: ['off', 'enforce'], defaultValue: 'off' },
	/** L5: the MTA spam verdict ends the Team run. Recorded either way. */
	mtaVerdictTerminal: { values: ['off', 'enforce'], defaultValue: 'off' },
	/** L6: folder, verdict and mail-kind gates before attachment indexing. */
	attachmentGates: { values: ['off', 'enforce'], defaultValue: 'off' },
	/** Phase 2: the category bundle; `enforce` changes display projections only. */
	categoryDisplayBundle: {
		values: ['off', 'shadow', 'enforce'],
		defaultValue: 'off',
		task: 'mail.category',
	},
	/** Phase 2: the reply-disposition bundle; `enforce` is advisory output only (D9). */
	dispositionAdvisoryBundle: {
		values: ['off', 'shadow', 'enforce'],
		defaultValue: 'off',
		task: 'mail.disposition',
	},
	/** D11: the message-only triage bundle before Team retrieval. Shadow only. */
	triageBundle: { values: ['off', 'shadow'], defaultValue: 'off', task: 'mail.triage' },
	/** Phase 3: claim verification through decision questions. */
	claimVerification: {
		values: ['off', 'shadow', 'enforce'],
		defaultValue: 'off',
		task: 'mail.claim_check',
	},
	/** D5: the necessity judgment; `off` keeps the sampling path (the kill switch). */
	clarifyNecessity: {
		values: ['off', 'shadow', 'enforce'],
		defaultValue: 'off',
		task: 'mail.necessity',
	},
	/** D2: a cheap writer first, for drafts a person reviews. */
	cheapFirstWriter: { values: ['off', 'reviewed'], defaultValue: 'off' },
	/** L14: provider batch APIs for non-interactive work. */
	batchApi: { values: ['off', 'enforce'], defaultValue: 'off' },
} as const satisfies Record<string, RoutingSwitchSpec>;

export type RoutingSwitchKey = keyof typeof ROUTING_SWITCHES;
export type RoutingSwitchValue<K extends RoutingSwitchKey> =
	(typeof ROUTING_SWITCHES)[K]['values'][number];
export type RoutingSwitches = { readonly [K in RoutingSwitchKey]: RoutingSwitchValue<K> };

export const ROUTING_SWITCH_KEYS = Object.keys(ROUTING_SWITCHES) as RoutingSwitchKey[];

/** Bounds for the two per-message caps (L7 knowledge entries, Phase 3 verified claims). */
export const ROUTING_CAP_MIN = 1;
export const ROUTING_CAP_MAX = 1000;

/**
 * D4's ceilings on shadow traffic: at most 10% of eligible messages and at most
 * 5% of the daily ceiling. An admin may lower either share, never raise it, so
 * the defaults below are these maxima.
 */
export const SHADOW_FRACTION_MAXIMA = {
	shadowMaxMessageFraction: 0.1,
	shadowMaxCeilingFraction: 0.05,
} as const;

/** The defaults of the numeric settings. Fractions are of the daily or monthly ceiling. */
const ROUTING_POLICY_NUMERIC_DEFAULTS = {
	/** D1: share of each ceiling held back for paid guard and classify calls. */
	triageAllowanceFraction: 0.1,
	/** D4: share of eligible messages that may be shadowed. */
	shadowMaxMessageFraction: SHADOW_FRACTION_MAXIMA.shadowMaxMessageFraction,
	/** D4: share of the daily ceiling shadow traffic may spend. */
	shadowMaxCeilingFraction: SHADOW_FRACTION_MAXIMA.shadowMaxCeilingFraction,
} as const;

/**
 * The stored row as the resolver reads it. Every field is optional: an absent
 * field (or no row at all) means its default, so a switch added later needs no
 * migration.
 */
export type RoutingPolicyRow = { readonly [K in RoutingSwitchKey]?: string } & {
	readonly policyVersion?: number;
	readonly knowledgeEntryCapPerMessage?: number;
	readonly verifyClaimCapPerMessage?: number;
	readonly promptCacheTasks?: readonly string[];
	readonly triageAllowanceFraction?: number;
	readonly shadowMaxMessageFraction?: number;
	readonly shadowMaxCeilingFraction?: number;
	readonly shadowCapUsd?: number;
	readonly updatedAt?: number;
};

/** The complete policy every lane reads. */
export type ResolvedRoutingPolicy = RoutingSwitches & {
	/** 0 when no row was ever saved; bumped by every save. Stamped on artifacts. */
	readonly policyVersion: number;
	/** L7. `null` = no cap (today). */
	readonly knowledgeEntryCapPerMessage: number | null;
	/** Phase 3. `null` = no cap (today). */
	readonly verifyClaimCapPerMessage: number | null;
	/** L9: tasks whose prompts carry cache markers. Empty = none (today). */
	readonly promptCacheTasks: readonly AiTaskName[];
	readonly triageAllowanceFraction: number;
	readonly shadowMaxMessageFraction: number;
	readonly shadowMaxCeilingFraction: number;
	/** D4: finite USD cap on shadow spend. `null` = unset. */
	readonly shadowCapUsd: number | null;
	/** When the stored row was last saved; `null` for the defaults. */
	readonly updatedAt: number | null;
};

function isFraction(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
}

function isCap(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= ROUTING_CAP_MIN &&
		value <= ROUTING_CAP_MAX
	);
}

/** A shadow share: a fraction no larger than its D4 maximum. */
function isShadowFraction(
	value: unknown,
	key: keyof typeof SHADOW_FRACTION_MAXIMA
): value is number {
	return isFraction(value) && value <= SHADOW_FRACTION_MAXIMA[key];
}

function isPositiveUsd(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function switchValue<K extends RoutingSwitchKey>(
	key: K,
	stored: string | undefined
): RoutingSwitchValue<K> {
	const spec: RoutingSwitchSpec = ROUTING_SWITCHES[key];
	const value = stored !== undefined && spec.values.includes(stored) ? stored : spec.defaultValue;
	return value as RoutingSwitchValue<K>;
}

/**
 * The complete policy for a stored row, or the defaults for none. Tolerant by
 * design: a value the validators would never store (a switch value from a newer
 * release read by an older one, a fraction out of range) reads as its default,
 * so a bad row can never switch a path on.
 */
export function resolveRoutingPolicy(
	row: RoutingPolicyRow | null | undefined
): ResolvedRoutingPolicy {
	const stored = row ?? {};
	const switches = Object.fromEntries(
		ROUTING_SWITCH_KEYS.map((key) => [key, switchValue(key, stored[key])])
	) as RoutingSwitches;
	const cacheTasks = (stored.promptCacheTasks ?? []).filter(isAiTaskName);
	return {
		...switches,
		policyVersion:
			typeof stored.policyVersion === 'number' && Number.isInteger(stored.policyVersion)
				? Math.max(0, stored.policyVersion)
				: 0,
		knowledgeEntryCapPerMessage: isCap(stored.knowledgeEntryCapPerMessage)
			? stored.knowledgeEntryCapPerMessage
			: null,
		verifyClaimCapPerMessage: isCap(stored.verifyClaimCapPerMessage)
			? stored.verifyClaimCapPerMessage
			: null,
		promptCacheTasks: [...new Set(cacheTasks)],
		triageAllowanceFraction: isFraction(stored.triageAllowanceFraction)
			? stored.triageAllowanceFraction
			: ROUTING_POLICY_NUMERIC_DEFAULTS.triageAllowanceFraction,
		shadowMaxMessageFraction: isShadowFraction(
			stored.shadowMaxMessageFraction,
			'shadowMaxMessageFraction'
		)
			? stored.shadowMaxMessageFraction
			: ROUTING_POLICY_NUMERIC_DEFAULTS.shadowMaxMessageFraction,
		shadowMaxCeilingFraction: isShadowFraction(
			stored.shadowMaxCeilingFraction,
			'shadowMaxCeilingFraction'
		)
			? stored.shadowMaxCeilingFraction
			: ROUTING_POLICY_NUMERIC_DEFAULTS.shadowMaxCeilingFraction,
		shadowCapUsd: isPositiveUsd(stored.shadowCapUsd) ? stored.shadowCapUsd : null,
		updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : null,
	};
}

/** The switches currently set to `shadow`. The shadow allowance applies while any is. */
export function shadowedSwitches(policy: RoutingSwitches): RoutingSwitchKey[] {
	return ROUTING_SWITCH_KEYS.filter((key) => policy[key] === 'shadow');
}

/**
 * D4: the most shadow traffic may spend today, in USD. Both limits apply: the
 * share of the daily ceiling and the explicit cap. With no daily ceiling the
 * explicit cap is required; without either, or with nothing set to shadow, the
 * allowance is zero and no shadow call is admitted.
 */
export function shadowAllowanceUsd(policy: ResolvedRoutingPolicy, dailyCeilingUsd: number): number {
	if (shadowedSwitches(policy).length === 0) return 0;
	const limits: number[] = [];
	if (dailyCeilingUsd > 0) limits.push(dailyCeilingUsd * policy.shadowMaxCeilingFraction);
	if (policy.shadowCapUsd !== null) limits.push(policy.shadowCapUsd);
	return limits.length === 0 ? 0 : Math.min(...limits);
}

/**
 * Why a policy cannot be saved, or `null` when it can. Checks the merged policy
 * (the stored row with the requested change applied), with the deployment's
 * configured daily ceiling, because D4's rule spans both: shadowing needs a
 * finite cap when no daily ceiling is set.
 */
export function routingPolicyProblem(
	row: RoutingPolicyRow,
	context: { readonly dailyCeilingUsd: number }
): string | null {
	for (const key of ROUTING_SWITCH_KEYS) {
		const value = row[key];
		const spec: RoutingSwitchSpec = ROUTING_SWITCHES[key];
		if (value !== undefined && !spec.values.includes(value)) {
			return `${key} must be one of ${spec.values.join(', ')}.`;
		}
	}
	const triage = row.triageAllowanceFraction;
	if (triage !== undefined && !isFraction(triage)) {
		return 'triageAllowanceFraction must be a fraction between 0 and 1, exclusive.';
	}
	for (const key of ['shadowMaxMessageFraction', 'shadowMaxCeilingFraction'] as const) {
		const value = row[key];
		if (value !== undefined && !isShadowFraction(value, key)) {
			return `${key} must be above 0 and at most ${SHADOW_FRACTION_MAXIMA[key]}.`;
		}
	}
	if (row.shadowCapUsd !== undefined && !isPositiveUsd(row.shadowCapUsd)) {
		return 'shadowCapUsd must be a positive amount.';
	}
	for (const key of ['knowledgeEntryCapPerMessage', 'verifyClaimCapPerMessage'] as const) {
		const value = row[key];
		if (value !== undefined && !isCap(value)) {
			return `${key} must be a whole number from ${ROUTING_CAP_MIN} to ${ROUTING_CAP_MAX}.`;
		}
	}
	const cacheTasks = row.promptCacheTasks ?? [];
	const unknownTask = cacheTasks.find((task) => !isAiTaskName(task));
	if (unknownTask !== undefined) return `Unknown task in promptCacheTasks: ${unknownTask}.`;
	if (new Set(cacheTasks).size !== cacheTasks.length) {
		return 'promptCacheTasks lists a task twice.';
	}
	const policy = resolveRoutingPolicy(row);
	if (
		shadowedSwitches(policy).length > 0 &&
		!(context.dailyCeilingUsd > 0) &&
		policy.shadowCapUsd === null
	) {
		return 'Set a shadow spending cap before shadowing: no daily ceiling is configured.';
	}
	return null;
}

// ── Stored enums the UI renders ───────────────────────────────────────────

/** D13: why the model guard was skipped for a Team message. */
/**
 * Why the scan did not run the model guard (D13): skipped for spam-archived mail
 * or while the agent is off, or refused by spend admission (D1, Sol r3 F1).
 * Each requires the guard before any later generative processing.
 */
export const GUARD_NOT_RUN_REASONS = ['spam_archived', 'agent_disabled', 'budget_refused'] as const;
export type GuardNotRunReason = (typeof GUARD_NOT_RUN_REASONS)[number];

/** D1: why a Team message waits for a person instead of the model path. */
export const BUDGET_HOLD_REASONS = [
	'daily_ceiling',
	'monthly_ceiling',
	'spend_unverifiable',
] as const;
export type BudgetHoldReason = (typeof BUDGET_HOLD_REASONS)[number];

/** D1: the model judgments a held message is missing. */
export const MISSING_JUDGMENTS = ['guard', 'classify', 'interpret', 'clarify', 'draft'] as const;
export type MissingJudgment = (typeof MISSING_JUDGMENTS)[number];

/**
 * D1 / U5: the stable code a spend-admission refusal carries. A refused paid
 * call throws `ConvexError({ category: 'forbidden', message, data: { code,
 * reason } })`, where `reason` is a {@link BudgetHoldReason}; the web reads
 * `error.data.data.code` to show the budget state instead of a generic error.
 */
export const AI_BUDGET_ERROR_CODE = 'AI_BUDGET_EXHAUSTED';

/**
 * D1 / U3: the error text a Team message held by the ceiling fails with. The
 * reason and the missing judgments are on the message's `budgetHold`.
 */
export const BUDGET_HOLD_ERROR_MESSAGE =
	'AI spend budget reached: the message waits for a person (no paid model calls ran).';

/**
 * Where an embedding row's space assignment came from. `measured`: stamped by
 * the writer from the space it embedded with. `record`: a backfill from retained
 * deployment or configuration records. `attestation`: an operator attested to
 * the cohort's space. A row with none of these is unknown, and vector search
 * excludes it.
 */
export const EMBEDDING_PROVENANCE_SOURCES = ['measured', 'record', 'attestation'] as const;
export type EmbeddingProvenanceSource = (typeof EMBEDDING_PROVENANCE_SOURCES)[number];

/** An embedding space's lifecycle. At most one is `active` and at most one `staged`. */
export const EMBEDDING_SPACE_STATES = ['staged', 'active', 'retired'] as const;
export type EmbeddingSpaceState = (typeof EMBEDDING_SPACE_STATES)[number];

/** `reembed`: unknown or inactive rows into the active space. `rebuild`: into a staged space. */
export const REEMBED_JOB_KINDS = ['reembed', 'rebuild'] as const;
export type ReembedJobKind = (typeof REEMBED_JOB_KINDS)[number];

export const REEMBED_JOB_STATUSES = [
	'running',
	'paused',
	'completed',
	'cancelled',
	'failed',
] as const;
export type ReembedJobStatus = (typeof REEMBED_JOB_STATUSES)[number];

export const REEMBED_PAUSE_REASONS = ['budget', 'provider_unavailable', 'space_changed'] as const;
export type ReembedPauseReason = (typeof REEMBED_PAUSE_REASONS)[number];

/** D10: why an interpretation source waits for the thread to be opened. */
export const INTERPRET_DEFER_REASONS = ['display_only'] as const;
export type InterpretDeferReason = (typeof INTERPRET_DEFER_REASONS)[number];
