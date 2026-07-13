/**
 * Natural-language handling rules — CRUD + deterministic evaluation surface.
 *
 * The user teaches the assistant in plain English; a cheap LLM compiles the
 * prose ONCE into a structured `{ matcher, action }` (see ./handlingRulesCompile.ts,
 * a 'use node' action) which this module persists, lists, edits, and revokes.
 * Everything here is deterministic and network-free — the matcher never calls a
 * model, so the untrusted inbound email can never reach an LLM through a rule.
 *
 * Single-org deployment → rules are deployment-global, mirroring autonomyRules.
 * Writes are owner/admin-only; the whole surface is gated on `ai.autonomy` (a
 * rule can scope autonomy, so it lives under the autonomy flag).
 */

import { v } from 'convex/values';
import { openInboundMessageBody } from '../lib/messageBody';
import { internalQuery } from '../_generated/server';
import { adminQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { assertFeatureEnabled, isFeatureEnabled } from '../lib/featureFlags';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';
import {
	evaluateHandlingRules,
	type HandlingRuleLike,
	type HandlingRuleOutcome,
} from './handlingRules/engine';

/**
 * Upper bound on how many handling rules a deployment can hold. The table is
 * deployment-global and hand-curated in settings (mirroring autonomyRules), so
 * this ceiling is generous while still keeping every read BOUNDED — the settings
 * list and the per-message evaluation both cap their fetch at this ceiling
 * (via `.take(MAX_HANDLING_RULES)`) rather than reading the table unbounded.
 */
export const MAX_HANDLING_RULES = 500;

// Shared validators — the persisted shape mirrors schema/autonomy.ts:handlingRules.
export const matcherValidator = v.object({
	senders: v.optional(v.array(v.string())),
	subjectContains: v.optional(v.array(v.string())),
	bodyContains: v.optional(v.array(v.string())),
	categories: v.optional(v.array(v.string())),
});

export const actionValidator = v.object({
	type: v.union(
		v.literal('draft_with_stance'),
		v.literal('categorize'),
		v.literal('auto_archive'),
		v.literal('always_ask'),
		v.literal('never_auto_send')
	),
	stance: v.optional(v.string()),
	category: v.optional(v.string()),
});

// ── Public read ───────────────────────────────────────────────────

/** All handling rules for the deployment — inspectable in settings. */
export const list = adminQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		return await ctx.db.query('handlingRules').take(MAX_HANDLING_RULES);
	},
});

// ── Public write (owner/admin) ────────────────────────────────────

/**
 * Persist a compiled rule. The prose `instruction` is trusted (user-authored);
 * the compiled `matcher`/`action` come from ./handlingRulesCompile.compile (or,
 * for a fully-manual rule, straight from the client). Owner/admin only.
 */
export const create = authedMutation({
	args: {
		instruction: v.string(),
		matcher: matcherValidator,
		action: actionValidator,
		isEnabled: v.optional(v.boolean()),
		compiledModel: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can change handling rules'
		);
		const instruction = args.instruction.trim();
		if (!instruction) throwInvalidInput('Rule text is required');
		assertMatcherNonEmpty(args.matcher);
		assertActionWellFormed(args.action);

		const now = Date.now();
		return await ctx.db.insert('handlingRules', {
			instruction,
			isEnabled: args.isEnabled ?? true,
			matcher: args.matcher,
			action: args.action,
			compiledModel: args.compiledModel,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/** Edit an existing rule (toggle, re-compiled matcher/action, or new prose). */
export const update = authedMutation({
	args: {
		ruleId: v.id('handlingRules'),
		instruction: v.optional(v.string()),
		matcher: v.optional(matcherValidator),
		action: v.optional(actionValidator),
		isEnabled: v.optional(v.boolean()),
		compiledModel: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can change handling rules'
		);
		await getOrThrow(ctx, args.ruleId, 'Handling rule');

		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		if (args.instruction !== undefined) {
			const trimmed = args.instruction.trim();
			if (!trimmed) throwInvalidInput('Rule text is required');
			patch['instruction'] = trimmed;
		}
		if (args.matcher !== undefined) {
			assertMatcherNonEmpty(args.matcher);
			patch['matcher'] = args.matcher;
		}
		if (args.action !== undefined) {
			assertActionWellFormed(args.action);
			patch['action'] = args.action;
		}
		if (args.isEnabled !== undefined) patch['isEnabled'] = args.isEnabled;
		if (args.compiledModel !== undefined) patch['compiledModel'] = args.compiledModel;
		await ctx.db.patch(args.ruleId, patch);
	},
});

/** Revoke a rule. Idempotent. Owner/admin only. */
export const remove = authedMutation({
	args: { ruleId: v.id('handlingRules') },
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can delete handling rules'
		);
		const existing = await ctx.db.get(args.ruleId);
		if (!existing) return;
		await ctx.db.delete(args.ruleId);
	},
});

// ── Internal evaluation (deterministic, network-free) ─────────────

/**
 * Evaluate every enabled handling rule against one inbound message. Used by the
 * classify step (category override / auto-archive) and by the route step's final
 * safety gate (RESTRICT-only auto-send). Returns an inert outcome — no matches,
 * no restriction — when the feature flag is off or the message is gone, so a
 * missing rule set degrades to today's non-rule behaviour.
 */
export const evaluateForMessage = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<HandlingRuleOutcome> => {
		const inert: HandlingRuleOutcome = {
			matchedInstructions: [],
			autoArchive: false,
			stances: [],
			restrictsAutoSend: false,
			reasons: [],
		};

		if (!(await isFeatureEnabled(ctx, 'ai.autonomy'))) return inert;

		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return inert;

		const rules = await ctx.db
			.query('handlingRules')
			.withIndex('by_enabled', (q) => q.eq('isEnabled', true))
			.take(MAX_HANDLING_RULES);
		if (rules.length === 0) return inert;

		const { text: bodyText, html: bodyHtml } = await openInboundMessageBody(message);
		const body = bodyText ?? (bodyHtml ? stripTags(bodyHtml) : '');
		return evaluateHandlingRules(rules as HandlingRuleLike[], {
			from: message.from ?? '',
			subject: message.subject ?? '',
			body,
			category: message.classification?.category,
		});
	},
});

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Minimal HTML→text for matching only (this module is a query, so it can't
 * import the 'use node' rfc822.stripHtml). Drops tags and collapses whitespace;
 * substring matching does not need faithful rendering. Bounded so a huge HTML
 * body can't blow up matching.
 */
function stripTags(html: string): string {
	return html
		.slice(0, 100_000)
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// ── Guards ────────────────────────────────────────────────────────

function assertMatcherNonEmpty(matcher: {
	senders?: string[];
	subjectContains?: string[];
	bodyContains?: string[];
	categories?: string[];
}): void {
	const hasFacet =
		(matcher.senders?.length ?? 0) > 0 ||
		(matcher.subjectContains?.length ?? 0) > 0 ||
		(matcher.bodyContains?.length ?? 0) > 0 ||
		(matcher.categories?.length ?? 0) > 0;
	if (!hasFacet) {
		throwInvalidInput('A rule needs at least one matcher (sender, subject, body, or category)');
	}
}

function assertActionWellFormed(action: {
	type: string;
	stance?: string;
	category?: string;
}): void {
	if (action.type === 'categorize' && !action.category?.trim()) {
		throwInvalidInput('A categorize rule needs a target category');
	}
	if (action.type === 'draft_with_stance' && !action.stance?.trim()) {
		throwInvalidInput('A draft-with-stance rule needs a stance');
	}
}
