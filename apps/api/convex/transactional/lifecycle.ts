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
 * Effects:
 *   audit_log                    — fires on every transition + create +
 *                                  duplicate + remove.
 *   record_content_scan_result   — fires on suspicious / blocked publish.
 *   update_block_usage_counts    — fires on create/duplicate when blocks
 *                                  are linked.
 *
 * See docs/adr/0022-template-lifecycle-modules.md.
 */

import { v } from 'convex/values';
import {
	internalMutation,
	type MutationCtx,
} from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { recordAuditLog, type AuditAction } from '../lib/auditLog';
import { applyUsageCountDelta } from '../emailBlocks/module';
import { buildSearchableText } from '../lib/queryHelpers';
import {
	CURRENT_CONTENT_BLOCK_VERSION,
	CURRENT_RENDERER_VERSION,
} from '../lib/constants';
import { dataVariablesSchemaValidator } from '../lib/convexValidators';
import { scanContent } from '@owlat/email-scanner';
import { throwAlreadyExists, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import type { ContentFlag, ContentScanLevel } from '@owlat/email-scanner';

// ─── Types ──────────────────────────────────────────────────────────────────

export type TransactionalEmailStatus = 'draft' | 'pending_review' | 'published';

/**
 * The `'approved' | 'rejected'` inputs are admin-driven; they resolve to
 * status patches (`published` / `draft`) inside the reducer but carry
 * distinct audit-log actions so the admin surface is identifiable.
 */
export type TransactionalEmailTransitionInput =
	| {
			to: 'published';
			at: number;
			htmlContent: string;
			htmlTranslations?: string;
	  }
	| { to: 'draft'; at: number }
	| { to: 'approved'; at: number }
	| { to: 'rejected'; at: number };

export type TransactionalEmailTransitionOutcome =
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

export type TransactionalEmailCreateOutcome =
	| { ok: true; emailId: Id<'transactionalEmails'> }
	| {
			ok: false;
			reason: 'invalid_slug_format' | 'slug_already_exists';
	  };

export type TransactionalEmailDuplicateOutcome =
	| { ok: true; emailId: Id<'transactionalEmails'> }
	| { ok: false; reason: 'email_not_found' };

export type TransactionalEmailRemoveOutcome =
	| { ok: true }
	| { ok: false; reason: 'email_not_found' };

// ─── Validators ─────────────────────────────────────────────────────────────

const transitionInputValidator = v.union(
	v.object({
		to: v.literal('published'),
		at: v.number(),
		htmlContent: v.string(),
		htmlTranslations: v.optional(v.string()),
	}),
	v.object({ to: v.literal('draft'), at: v.number() }),
	v.object({ to: v.literal('approved'), at: v.number() }),
	v.object({ to: v.literal('rejected'), at: v.number() }),
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────
//
// `approved` / `rejected` resolve to statuses; the legal-edges graph
// uses the resolved target.

export const LEGAL_EDGES: Record<
	TransactionalEmailStatus,
	ReadonlySet<TransactionalEmailStatus>
> = {
	draft: new Set<TransactionalEmailStatus>(['published', 'pending_review']),
	pending_review: new Set<TransactionalEmailStatus>(['published', 'draft']),
	published: new Set<TransactionalEmailStatus>(['draft']),
};

// Map the input.to (admin actions) to the resolved persisted status.
function resolvedTargetStatus(
	input: TransactionalEmailTransitionInput,
): TransactionalEmailStatus {
	switch (input.to) {
		case 'published':
			return 'published';
		case 'draft':
			return 'draft';
		case 'approved':
			return 'published';
		case 'rejected':
			return 'draft';
	}
}

// ─── Effects ────────────────────────────────────────────────────────────────

type Effect =
	| {
			kind: 'audit_log';
			action: AuditAction;
			emailId: Id<'transactionalEmails'>;
			userId: string;
			details: Record<string, string | number | boolean | null>;
	  }
	| {
			kind: 'record_content_scan_result';
			emailId: Id<'transactionalEmails'>;
			score: number;
			level: ContentScanLevel;
			flags: ContentFlag[];
	  }
	| {
			kind: 'update_block_usage_counts';
			previousIds: string[];
			nextIds: string[];
	  };

type ReducerResult = {
	patch: Record<string, unknown>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
	/** Resolved target status persisted to the row. */
	resolvedTo: TransactionalEmailStatus;
};

// ─── Reducer ────────────────────────────────────────────────────────────────

function reduce(
	email: Doc<'transactionalEmails'>,
	input: TransactionalEmailTransitionInput,
	userId: string,
): ReducerResult {
	const from = email.status as TransactionalEmailStatus;
	const resolvedTo = resolvedTargetStatus(input);

	// ─── Idempotent same-state ─────────────────────────────────────────────
	// `published → published` is idempotent unless the caller passes a
	// `to: 'published'` (publish-with-scan) — that path runs the scan and
	// patches regardless. `draft → draft`, `pending_review → pending_review`
	// idempotent and just record.
	if (from === resolvedTo && input.to !== 'published') {
		return {
			patch: {},
			effects: [
				{
					kind: 'audit_log',
					action: auditActionFor(input, from),
					emailId: email._id,
					userId,
					details: {
						previousStatus: from,
						newStatus: resolvedTo,
						applied: 'recorded',
					},
				},
			],
			applied: 'recorded',
			resolvedTo,
		};
	}

	// ─── Publish-with-scan reducer ─────────────────────────────────────────
	if (input.to === 'published') {
		const scanResult = scanContent(email.subject, input.htmlContent);

		if (scanResult.level === 'blocked') {
			// Record scan result first (audit), then throw.
			// The throw bubbles up through dispatch; we attach scan info to
			// `data` so a consumer can surface the score/flags without parsing
			// the message.
			throwInvalidState(
				`Content blocked by our content scanner (score: ${scanResult.score}/100). ` +
					`Issues: ${scanResult.flags.map((f) => f.description).join('; ')}. ` +
					'Please review and update your content before publishing.',
				{ scanScore: scanResult.score },
			);
		}

		if (scanResult.level === 'suspicious') {
			// → pending_review. Patch htmlContent + htmlTranslations but
			// NOT status='published' or publishedAt. Audit + record scan.
			const patch: Record<string, unknown> = {
				status: 'pending_review',
				htmlContent: input.htmlContent,
				htmlTranslations: input.htmlTranslations,
				updatedAt: input.at,
			};
			// Idempotent: pending_review → pending_review is still applied
			// (the user re-uploaded content) — record as transitioned for
			// audit clarity.
			const fromForAudit = from;
			return {
				patch,
				effects: [
					{
						kind: 'audit_log',
						action: 'transactional_email.flagged_for_review',
						emailId: email._id,
						userId,
						details: {
							previousStatus: fromForAudit,
							newStatus: 'pending_review',
							score: scanResult.score,
							applied: 'transitioned',
						},
					},
					{
						kind: 'record_content_scan_result',
						emailId: email._id,
						score: scanResult.score,
						level: scanResult.level,
						flags: scanResult.flags,
					},
				],
				applied: 'transitioned',
				resolvedTo: 'pending_review',
			};
		}

		// clean → publish proper.
		return {
			patch: buildPatch(input, resolvedTo),
			effects: [
				{
					kind: 'audit_log',
					action: 'transactional_email.published',
					emailId: email._id,
					userId,
					details: {
						previousStatus: from,
						newStatus: 'published',
						applied: 'transitioned',
					},
				},
			],
			applied: 'transitioned',
			resolvedTo: 'published',
		};
	}

	// ─── Non-publish transitions ───────────────────────────────────────────
	return {
		patch: buildPatch(input, resolvedTo),
		effects: [
			{
				kind: 'audit_log',
				action: auditActionFor(input, from),
				emailId: email._id,
				userId,
				details: {
					previousStatus: from,
					newStatus: resolvedTo,
					applied: 'transitioned',
				},
			},
		],
		applied: 'transitioned',
		resolvedTo,
	};
}

function auditActionFor(
	input: TransactionalEmailTransitionInput,
	from: TransactionalEmailStatus,
): AuditAction {
	switch (input.to) {
		case 'published':
			return 'transactional_email.published';
		case 'draft':
			// `published → draft` is the unpublish edge.
			// `pending_review → draft` is admin reject (handled via `rejected`).
			// Plain `→ draft` when not from pending_review is a normal unpublish.
			if (from === 'pending_review') {
				return 'transactional_email.unpublished';
			}
			return 'transactional_email.unpublished';
		case 'approved':
			return 'transactional_email.approved';
		case 'rejected':
			return 'transactional_email.rejected';
	}
}

function buildPatch(
	input: TransactionalEmailTransitionInput,
	resolvedTo: TransactionalEmailStatus,
): Record<string, unknown> {
	switch (input.to) {
		case 'published': {
			// Reached only on `scanResult.level === 'clean'`.
			return {
				status: 'published',
				htmlContent: input.htmlContent,
				htmlTranslations: input.htmlTranslations,
				publishedAt: input.at,
				updatedAt: input.at,
			};
		}
		case 'draft':
			return {
				status: 'draft',
				publishedAt: undefined,
				updatedAt: input.at,
			};
		case 'approved':
			return {
				status: 'published',
				publishedAt: input.at,
				updatedAt: input.at,
			};
		case 'rejected':
			return {
				status: 'draft',
				publishedAt: undefined,
				updatedAt: input.at,
			};
	}
	// Exhaustive — TS knows the switch covers all variants.
	// `resolvedTo` is only used for tighter typing of the return-type union.
	return { status: resolvedTo };
}

// ─── Effect runner ──────────────────────────────────────────────────────────

async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>,
): Promise<void> {
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
	userId: string,
): Promise<TransactionalEmailTransitionOutcome> {
	const from = email.status as TransactionalEmailStatus;
	const resolvedTo = resolvedTargetStatus(input);
	const isLegal = LEGAL_EDGES[from].has(resolvedTo);
	const isSelfLoop = from === resolvedTo;

	if (!isLegal && !isSelfLoop) {
		return { ok: false, reason: 'illegal_edge', from, to: resolvedTo };
	}

	const result = reduce(email, input, userId);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(
			email._id,
			result.patch as Partial<Doc<'transactionalEmails'>>,
		);
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
			content: args.content ?? '[]',
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
	handler: async (
		ctx,
		args,
	): Promise<TransactionalEmailTransitionOutcome> => {
		const email = await ctx.db.get(args.emailId);
		if (!email) return { ok: false, reason: 'email_not_found' };
		return await dispatch(ctx, email, args.input, args.userId);
	},
});

/**
 * Duplicate a transactional email. The copy lands at `draft`, gets a
 * unique slug (suffixed with `-copy[-N]`).
 */
export const duplicate = internalMutation({
	args: {
		emailId: v.id('transactionalEmails'),
		userId: v.string(),
	},
	handler: async (
		ctx,
		args,
	): Promise<TransactionalEmailDuplicateOutcome> => {
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
			name: newName,
			slug: newSlug,
			subject: email.subject,
			content: email.content,
			htmlContent: email.htmlContent,
			dataVariablesSchema: email.dataVariablesSchema,
			status: 'draft',
			defaultLanguage: email.defaultLanguage,
			supportedLanguages: email.supportedLanguages,
			translations: email.translations,
			linkedBlockIds: email.linkedBlockIds,
			contentBlockVersion:
				email.contentBlockVersion ?? CURRENT_CONTENT_BLOCK_VERSION,
			rendererVersion: email.rendererVersion ?? CURRENT_RENDERER_VERSION,
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
 * Delete a transactional email. Emits an audit log; block usage counts
 * for `linkedBlockIds` are NOT decremented today (left as follow-up).
 */
export const remove = internalMutation({
	args: {
		emailId: v.id('transactionalEmails'),
		userId: v.string(),
	},
	handler: async (
		ctx,
		args,
	): Promise<TransactionalEmailRemoveOutcome> => {
		const email = await ctx.db.get(args.emailId);
		if (!email) return { ok: false, reason: 'email_not_found' };

		const name = email.name;
		const slug = email.slug;
		await ctx.db.delete(args.emailId);

		await applyEffects(ctx, [
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
		]);

		return { ok: true };
	},
});

// ─── Publish invariant guard ────────────────────────────────────────────────

/**
 * Refuse to mutate publishable content on a `published` row unless the
 * caller passes `forceWhilePublished: true`. Consumed by every mutation
 * in `transactional/` that touches publishable content.
 *
 * Mirrors the email-template guard with the same shape; both throw
 * `invalid_state` with `data.action = 'unpublish'` to keep error handling
 * parallel.
 */
export function assertEditableForPublishableChange(
	email: Doc<'transactionalEmails'>,
	force?: boolean,
): void {
	if (email.status === 'published' && !force) {
		throwInvalidState(
			'Transactional email is published. Pass forceWhilePublished: true or unpublish first.',
			{ action: 'unpublish' },
		);
	}
}

// Re-export error throwers used by callers that translate create-outcome
// reasons. Keep here so callers don't import _utils/errors twice.
export { throwAlreadyExists, throwInvalidInput };
