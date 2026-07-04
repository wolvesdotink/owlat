/**
 * Natural-language handling rules.
 *
 * The user teaches standing intent in prose ("draft a polite decline for
 * recruiters", "flag anything from legal for me", "auto-archive newsletters").
 * A cheap LLM compiles the trusted, user-authored rule text into a
 * deterministic `matcher` (AND-ed conditions over the UNTRUSTED inbound email)
 * plus an `action`. Compilation runs out-of-band in mail/handlingRulesCompile.ts
 * (an internalAction, 'use node'); this module owns the table, its CRUD, and the
 * PURE deterministic evaluator the pipeline runs.
 *
 * SAFETY INVARIANTS:
 *   - A rule is only ever consulted while `status: 'active'` AND `isEnabled`, and
 *     only if it carries a compiled `matcher`. A still-compiling / failed /
 *     disabled rule is inert (fail-soft — a bad compile never touches ingest or
 *     the send gate).
 *   - The evaluator can ONLY ever RESTRICT auto-send (force human review) — it
 *     exposes no field that grants or widens an auto-send. See
 *     {@link HandlingRuleOutcome}.
 *   - The evaluator is a pure function over a fixed operator allowlist — no
 *     `eval`, no shell-out, mirroring mail/filters.ts.
 */

import { v } from 'convex/values';
import { adminQuery, authedMutation } from '../lib/authedFunctions';
import { internalMutation, internalQuery } from '../_generated/server';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { throwInvalidInput, throwNotFound } from '../_utils/errors';

// ── Shared shapes ─────────────────────────────────────────────────

/** Actions that, when a rule matches, only ever RESTRICT auto-send. */
const RESTRICTING_ACTIONS: ReadonlySet<string> = new Set([
	'never_auto_send',
	'draft_with_stance',
	'always_ask',
]);

/** The matcher/action shape written by the compiler (mutation validator). */
export const handlingCompilationValidator = v.object({
	matcher: v.object({
		conditions: v.array(
			v.object({
				field: v.union(v.literal('from'), v.literal('subject'), v.literal('body')),
				op: v.union(v.literal('contains'), v.literal('equals'), v.literal('matches')),
				value: v.string(),
			})
		),
	}),
	action: v.union(
		v.literal('draft_with_stance'),
		v.literal('categorize'),
		v.literal('auto_archive'),
		v.literal('always_ask'),
		v.literal('never_auto_send')
	),
	stance: v.optional(v.string()),
	category: v.optional(v.string()),
});

// ── Public CRUD (settings surface) ────────────────────────────────

/** All handling rules, for the settings list (inspect / edit / revoke). */
export const list = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db.query('handlingRules').collect(); // bounded: a per-org standing-intent list, intrinsically small.
	},
});

/**
 * Create a rule from prose. Stores it `status: 'compiling'` (inert until the
 * compiler fills in a matcher) and schedules the out-of-band compile.
 */
export const create = authedMutation({
	args: { naturalLanguage: v.string() },
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can change handling rules'
		);
		const text = args.naturalLanguage.trim();
		if (!text) throwInvalidInput('Rule text is required');
		if (text.length > 2000) throwInvalidInput('Rule text is too long');

		const now = Date.now();
		const ruleId = await ctx.db.insert('handlingRules', {
			naturalLanguage: text,
			status: 'compiling',
			isEnabled: true,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.mail.handlingRulesCompile.compile, { ruleId });
		return ruleId;
	},
});

/**
 * Edit a rule. Changing the text re-compiles it (status → 'compiling', matcher
 * cleared so the stale matcher can't fire while the new text compiles). Toggling
 * `isEnabled` does not re-compile.
 */
export const update = authedMutation({
	args: {
		ruleId: v.id('handlingRules'),
		naturalLanguage: v.optional(v.string()),
		isEnabled: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can change handling rules'
		);
		const rule = await ctx.db.get(args.ruleId);
		if (!rule) throwNotFound('Handling rule');

		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		let recompile = false;
		if (args.naturalLanguage !== undefined) {
			const text = args.naturalLanguage.trim();
			if (!text) throwInvalidInput('Rule text is required');
			if (text.length > 2000) throwInvalidInput('Rule text is too long');
			if (text !== rule.naturalLanguage) {
				patch['naturalLanguage'] = text;
				patch['status'] = 'compiling';
				patch['matcher'] = undefined;
				patch['action'] = undefined;
				patch['stance'] = undefined;
				patch['category'] = undefined;
				patch['compileError'] = undefined;
				recompile = true;
			}
		}
		if (args.isEnabled !== undefined) patch['isEnabled'] = args.isEnabled;

		await ctx.db.patch(args.ruleId, patch);
		if (recompile) {
			await ctx.scheduler.runAfter(0, internal.mail.handlingRulesCompile.compile, {
				ruleId: args.ruleId,
			});
		}
	},
});

/** Revoke a rule. After this it no longer matches anything. */
export const remove = authedMutation({
	args: { ruleId: v.id('handlingRules') },
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can delete handling rules'
		);
		const rule = await ctx.db.get(args.ruleId);
		if (!rule) return;
		await ctx.db.delete(args.ruleId);
	},
});

// ── Internal — pipeline reads + compiler write-back ───────────────

/**
 * The active, enabled rules the deterministic pipeline evaluates. Session-less;
 * consumed by the classify step and the auto-send gate in the route step.
 */
export const listActiveInternal = internalQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('handlingRules')
			.withIndex('by_status', (q) => q.eq('status', 'active'))
			.collect(); // bounded: intrinsically small per-org standing-intent list.
	},
});

/** Read one rule for the compiler (it holds the source text). */
export const getForCompile = internalQuery({
	args: { ruleId: v.id('handlingRules') },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.ruleId);
	},
});

/**
 * Write-back from the compiler. On success it stores the compiled matcher +
 * action and flips the rule to 'active'; on failure it records the error and
 * flips it to 'failed' (leaving the rule inert). Only ever called by the
 * out-of-band compile action.
 */
export const applyCompilation = internalMutation({
	args: {
		ruleId: v.id('handlingRules'),
		result: v.optional(handlingCompilationValidator),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const rule = await ctx.db.get(args.ruleId);
		if (!rule) return; // rule was revoked while compiling — nothing to write

		if (args.result) {
			await ctx.db.patch(args.ruleId, {
				status: 'active',
				matcher: args.result.matcher,
				action: args.result.action,
				stance: args.result.stance,
				category: args.result.category,
				compileError: undefined,
				updatedAt: Date.now(),
			});
			return;
		}

		await ctx.db.patch(args.ruleId, {
			status: 'failed',
			compileError: args.error ?? 'Could not compile this rule.',
			updatedAt: Date.now(),
		});
	},
});

// ── Pure deterministic evaluator ──────────────────────────────────

/** Lowercased fields a matcher condition can test. */
export interface HandlingEvalMessage {
	from: string;
	subject: string;
	body: string;
}

/** Project an inbound message doc (or a subset of it) into an eval message. */
export function toHandlingEvalMessage(msg: {
	from?: string;
	subject?: string;
	textBody?: string;
	htmlBody?: string;
}): HandlingEvalMessage {
	return {
		from: (msg.from ?? '').toLowerCase(),
		subject: (msg.subject ?? '').toLowerCase(),
		body: ((msg.textBody ?? '') + ' ' + (msg.htmlBody ?? '')).toLowerCase(),
	};
}

type HandlingCondition = NonNullable<Doc<'handlingRules'>['matcher']>['conditions'][number];

function conditionMatches(condition: HandlingCondition, message: HandlingEvalMessage): boolean {
	const lhs =
		condition.field === 'from'
			? message.from
			: condition.field === 'subject'
				? message.subject
				: message.body;
	const value = condition.value.toLowerCase();
	switch (condition.op) {
		case 'contains':
			return value.length > 0 && lhs.includes(value);
		case 'equals':
			return lhs === value;
		case 'matches': {
			try {
				return new RegExp(condition.value, 'i').test(lhs);
			} catch {
				return false;
			}
		}
		default:
			return false;
	}
}

/**
 * The deterministic outcome of evaluating all active rules against one message.
 *
 * NOTE — by construction this exposes NO field that grants or widens an
 * auto-send. `restrictAutoSend` can only turn a would-be auto-send into human
 * review; `autoArchive` and `forcedCategory` shape classification. This is the
 * structural guarantee behind "a rule can only ever RESTRICT, never widen,
 * auto-send".
 */
export interface HandlingRuleOutcome {
	matchedRuleIds: Id<'handlingRules'>[];
	/** True if any matched rule requires a human before sending. */
	restrictAutoSend: boolean;
	/** Human-readable reason for the restriction (first matching rule). */
	restrictReason?: string;
	/** True if any matched rule archives the message without a reply. */
	autoArchive: boolean;
	/** Category a matched `categorize` rule forces onto the classification. */
	forcedCategory?: string;
	/** Stances from matched `draft_with_stance` rules, for the drafter. */
	stances: string[];
}

/**
 * Evaluate the active handling rules against a message. Pure — safe to call from
 * a query, a step, or a test. Only rules that are enabled, active, and carry a
 * compiled matcher are considered; each rule's conditions are AND-ed.
 */
export function evaluateHandlingRules(
	rules: Doc<'handlingRules'>[],
	message: HandlingEvalMessage
): HandlingRuleOutcome {
	const matchedRuleIds: Id<'handlingRules'>[] = [];
	const stances: string[] = [];
	let restrictAutoSend = false;
	let restrictReason: string | undefined;
	let autoArchive = false;
	let forcedCategory: string | undefined;

	for (const rule of rules) {
		if (!rule.isEnabled || rule.status !== 'active' || !rule.matcher) continue;
		if (rule.matcher.conditions.length === 0) continue;

		let allMatch = true;
		for (const condition of rule.matcher.conditions) {
			if (!conditionMatches(condition, message)) {
				allMatch = false;
				break;
			}
		}
		if (!allMatch) continue;

		matchedRuleIds.push(rule._id);
		const action = rule.action;

		if (action && RESTRICTING_ACTIONS.has(action)) {
			restrictAutoSend = true;
			if (!restrictReason) {
				restrictReason = `Handling rule "${rule.naturalLanguage}" requires human review before sending; routing to human review.`;
			}
		}
		if (action === 'auto_archive') autoArchive = true;
		if (action === 'categorize' && rule.category && !forcedCategory) {
			forcedCategory = rule.category;
		}
		if (action === 'draft_with_stance' && rule.stance) {
			stances.push(rule.stance);
		}
	}

	return { matchedRuleIds, restrictAutoSend, restrictReason, autoArchive, forcedCategory, stances };
}
