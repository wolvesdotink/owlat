/**
 * Transactional email lifecycle (module) — single writer of
 * `transactionalEmails.status` and its companion fields (`publishedAt`,
 * `htmlContent`, `htmlTranslations`), plus the only place that inserts
 * and deletes `transactionalEmails` rows.
 *
 * Three states: `draft | pending_review | published`. The `→ published`
 * reducer runs `scanContent(subject, htmlContent)` inline:
 *   - clean      → patch `status: 'published'` + `publishedAt`
 *   - suspicious → patch `status: 'pending_review'` + record scan result
 *   - blocked    → throwInvalidState (content blocked by scanner)
 *
 * The admin `→ approved` reducer assumes the scan happened on the prior
 * `→ pending_review` transition and patches `status: 'published'` without
 * re-scanning. `→ rejected` patches back to `draft`.
 *
 * Sibling of the **Email template lifecycle (module)** which owns a
 * parallel-shape 2-state graph on the `emailTemplates` table.
 *
 * The pure half (status and transition types, validator, graph, reducer)
 * lives in `lifecycleReducer.ts`; this module applies its result, runs the
 * effects, and inserts and deletes the rows.
 *
 * Effects:
 *   audit_log                    — fires on every transition + create +
 *                                  duplicate + remove.
 *   record_content_scan_result   — fires on suspicious / blocked publish.
 *   update_block_usage_counts    — fires on create/duplicate/remove when
 *                                  blocks are linked.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog } from '../lib/auditLog';
import { refuse } from '../lib/lifecycle';
import { applyUsageCountDelta } from '../emailBlocks/module';
import { buildSearchableText } from '../lib/queryHelpers';
import { duplicateEmailFields } from '../lib/publishableEmail';
import { loadEmailTheme } from '../lib/publishableEmailRender';
import { sanitizeStoredBlocksJson } from '../lib/emailContentSanitize';
import { CURRENT_CONTENT_BLOCK_VERSION, CURRENT_RENDERER_VERSION } from '../lib/constants';
import { dataVariablesSchemaValidator } from '../lib/convexValidators';
import { deleteCoeditState } from '../emailCoediting/sweep';
import {
	TRANSACTIONAL_EMAIL_LIFECYCLE,
	reduce,
	resolvedTargetStatus,
	transitionInputValidator,
	type Effect,
	type TransactionalEmailStatus,
	type TransactionalEmailTransitionInput,
} from './lifecycleReducer';

export type { TransactionalEmailStatus } from './lifecycleReducer';

// ─── Types ──────────────────────────────────────────────────────────────────

type TransactionalEmailTransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: TransactionalEmailStatus;
			to: TransactionalEmailStatus;
			emailId: Id<'transactionalEmails'>;
	  }
	| {
			ok: false;
			reason: 'email_not_found' | 'illegal_edge';
			from?: TransactionalEmailStatus;
			to?: TransactionalEmailStatus;
	  };

type TransactionalEmailCreateOutcome =
	| { ok: true; emailId: Id<'transactionalEmails'> }
	| {
			ok: false;
			reason: 'invalid_slug_format' | 'slug_already_exists';
	  };

type TransactionalEmailDuplicateOutcome =
	| { ok: true; emailId: Id<'transactionalEmails'> }
	| { ok: false; reason: 'email_not_found' };

type TransactionalEmailRemoveOutcome = { ok: true } | { ok: false; reason: 'email_not_found' };

// ─── Effect runner ──────────────────────────────────────────────────────────

async function applyEffects(ctx: MutationCtx, effects: ReadonlyArray<Effect>): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: effect.userId,
					action: effect.action,
					resource: 'transactional_email',
					resourceId: effect.emailId,
					details: effect.details,
				});
				break;
			}
			case 'record_content_scan_result': {
				await ctx.db.insert('contentScanResults', {
					resourceType: 'transactional',
					resourceId: effect.emailId,
					score: effect.score,
					level: effect.level,
					flags: effect.flags,
					scannedAt: Date.now(),
				});
				break;
			}
			case 'update_block_usage_counts': {
				await applyUsageCountDelta(ctx, effect.previousIds, effect.nextIds);
				break;
			}
		}
	}
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	email: Doc<'transactionalEmails'>,
	input: TransactionalEmailTransitionInput,
	userId: string
): Promise<TransactionalEmailTransitionOutcome> {
	const from = email.status as TransactionalEmailStatus;
	const resolvedTo = resolvedTargetStatus(input);
	const verdict = TRANSACTIONAL_EMAIL_LIFECYCLE.classify(from, resolvedTo);

	if (verdict.kind === 'refused') {
		return refuse(verdict);
	}

	const result = reduce(email, input, userId);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(email._id, result.patch as Partial<Doc<'transactionalEmails'>>);
	}
	await applyEffects(ctx, result.effects);

	return {
		ok: true,
		applied: result.applied,
		from,
		to: result.resolvedTo,
		emailId: email._id,
	};
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Insert a new `transactionalEmails` row at `draft`. The only insert
 * site for `transactionalEmails`.
 */
export const create = internalMutation({
	args: {
		name: v.string(),
		slug: v.string(),
		subject: v.optional(v.string()),
		content: v.optional(v.string()),
		dataVariablesSchema: v.optional(dataVariablesSchemaValidator),
		defaultLanguage: v.optional(v.string()),
		linkedBlockIds: v.optional(v.array(v.string())),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<TransactionalEmailCreateOutcome> => {
		const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
		if (!slugRegex.test(args.slug)) {
			return { ok: false, reason: 'invalid_slug_format' };
		}

		const existing = await ctx.db
			.query('transactionalEmails')
			.withIndex('by_slug', (q) => q.eq('slug', args.slug))
			.first();
		if (existing) {
			return { ok: false, reason: 'slug_already_exists' };
		}

		const now = Date.now();
		const defaultLanguage = args.defaultLanguage ?? 'en';
		const subject = args.subject ?? '';
		const searchableText = buildSearchableText(args.name, subject, args.slug);

		const emailId = await ctx.db.insert('transactionalEmails', {
			name: args.name,
			slug: args.slug,
			subject,
			content: sanitizeStoredBlocksJson(args.content ?? '[]'),
			dataVariablesSchema: args.dataVariablesSchema,
			status: 'draft',
			defaultLanguage,
			supportedLanguages: [defaultLanguage],
			linkedBlockIds: args.linkedBlockIds,
			contentBlockVersion: CURRENT_CONTENT_BLOCK_VERSION,
			rendererVersion: CURRENT_RENDERER_VERSION,
			searchableText,
			createdAt: now,
			updatedAt: now,
		});

		const effects: Effect[] = [
			{
				kind: 'audit_log',
				action: 'transactional_email.created',
				emailId,
				userId: args.userId,
				details: {
					name: args.name,
					slug: args.slug,
					applied: 'transitioned',
				},
			},
		];
		if (args.linkedBlockIds && args.linkedBlockIds.length > 0) {
			effects.push({
				kind: 'update_block_usage_counts',
				previousIds: [],
				nextIds: args.linkedBlockIds,
			});
		}
		await applyEffects(ctx, effects);

		return { ok: true, emailId };
	},
});

/**
 * Apply a transactional-email status transition. The only writer of
 * `transactionalEmails.status` and its companion fields. Atomic with:
 * row patch + audit-log row (+ content-scan-result row on suspicious /
 * blocked publishes).
 *
 * The `→ published` input runs `scanContent` inline and may resolve to
 * `pending_review` (suspicious) or throw `invalid_state` (blocked).
 */
export const transition = internalMutation({
	args: {
		emailId: v.id('transactionalEmails'),
		input: transitionInputValidator,
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<TransactionalEmailTransitionOutcome> => {
		const email = await ctx.db.get(args.emailId);
		if (!email) return { ok: false, reason: 'email_not_found' };
		return await dispatch(ctx, email, args.input, args.userId);
	},
});

/**
 * Duplicate a transactional email. The copy lands at `draft`, gets a
 * unique slug (suffixed with `-copy[-N]`) and carries every content column
 * of the source, attachments included (`duplicateEmailFields`).
 */
export const duplicate = internalMutation({
	args: {
		emailId: v.id('transactionalEmails'),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<TransactionalEmailDuplicateOutcome> => {
		const email = await ctx.db.get(args.emailId);
		if (!email) return { ok: false, reason: 'email_not_found' };

		let newSlug = `${email.slug}-copy`;
		let counter = 1;
		while (true) {
			const existing = await ctx.db
				.query('transactionalEmails')
				.withIndex('by_slug', (q) => q.eq('slug', newSlug))
				.first();
			if (!existing) break;
			counter++;
			newSlug = `${email.slug}-copy-${counter}`;
		}

		const now = Date.now();
		const newName = `${email.name} (Copy)`;
		const searchableText = buildSearchableText(newName, email.subject, newSlug);

		const newId = await ctx.db.insert('transactionalEmails', {
			...duplicateEmailFields(email, { variableType: 'data', theme: await loadEmailTheme(ctx) }),
			name: newName,
			slug: newSlug,
			status: 'draft',
			searchableText,
			createdAt: now,
			updatedAt: now,
		});

		const effects: Effect[] = [
			{
				kind: 'audit_log',
				action: 'transactional_email.duplicated',
				emailId: newId,
				userId: args.userId,
				details: {
					sourceEmailId: args.emailId,
					name: newName,
					slug: newSlug,
					applied: 'transitioned',
				},
			},
		];
		if (email.linkedBlockIds && email.linkedBlockIds.length > 0) {
			effects.push({
				kind: 'update_block_usage_counts',
				previousIds: [],
				nextIds: email.linkedBlockIds,
			});
		}
		await applyEffects(ctx, effects);

		return { ok: true, emailId: newId };
	},
});

/**
 * Delete a transactional email. Emits an audit log and decrements the usage
 * counts of any saved blocks the email linked, so the block library's "X uses"
 * count stays accurate after a delete.
 */
export const remove = internalMutation({
	args: {
		emailId: v.id('transactionalEmails'),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<TransactionalEmailRemoveOutcome> => {
		const email = await ctx.db.get(args.emailId);
		if (!email) return { ok: false, reason: 'email_not_found' };

		const name = email.name;
		const slug = email.slug;
		await ctx.db.delete(args.emailId);
		await deleteCoeditState(ctx, { type: 'transactionalEmail', id: args.emailId });

		const effects: Effect[] = [
			{
				kind: 'audit_log',
				action: 'transactional_email.deleted',
				emailId: args.emailId,
				userId: args.userId,
				details: {
					name,
					slug,
					applied: 'transitioned',
				},
			},
		];
		if (email.linkedBlockIds && email.linkedBlockIds.length > 0) {
			effects.push({
				kind: 'update_block_usage_counts',
				previousIds: email.linkedBlockIds,
				nextIds: [],
			});
		}
		await applyEffects(ctx, effects);

		return { ok: true };
	},
});
