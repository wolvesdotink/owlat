/**
 * Email template lifecycle (module) — single writer of
 * `emailTemplates.status` and its companion fields (`publishedAt`,
 * `htmlContent`, `htmlTranslations`), plus the only place that inserts
 * and deletes `emailTemplates` rows.
 *
 * Two states: `draft | published`. No content-scan gate (marketing
 * templates are scanned at send time by the Campaign send orchestrator;
 * a publish-time scan would be redundant).
 *
 * Sibling of the **Transactional email lifecycle (module)** which owns
 * a parallel-shape 3-state graph on the `transactionalEmails` table.
 *
 * Effects:
 *   audit_log                    — fires on every transition + create +
 *                                  duplicate + remove.
 *   update_block_usage_counts    — fires on create/duplicate/remove and on
 *                                  any transition that swaps content.
 *
 * See docs/adr/0022-template-lifecycle-modules.md.
 */

import { v } from 'convex/values';
import { emailTemplateTypeValidator } from '../lib/convexValidators';
import { throwInvalidState } from '../_utils/errors';
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

// ─── Types ──────────────────────────────────────────────────────────────────

export type EmailTemplateStatus = 'draft' | 'published';

export type EmailTemplateTransitionInput =
	| {
			to: 'published';
			at: number;
			htmlContent: string;
			htmlTranslations?: string;
	  }
	| { to: 'draft'; at: number };

export type EmailTemplateTransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: EmailTemplateStatus;
			to: EmailTemplateStatus;
			templateId: Id<'emailTemplates'>;
	  }
	| {
			ok: false;
			reason: 'template_not_found' | 'illegal_edge';
			from?: EmailTemplateStatus;
			to?: EmailTemplateStatus;
	  };

export type EmailTemplateCreateOutcome = {
	ok: true;
	templateId: Id<'emailTemplates'>;
};

export type EmailTemplateDuplicateOutcome =
	| { ok: true; templateId: Id<'emailTemplates'> }
	| { ok: false; reason: 'template_not_found' };

export type EmailTemplateRemoveOutcome =
	| { ok: true }
	| { ok: false; reason: 'template_not_found' };

// ─── Validators ─────────────────────────────────────────────────────────────

const transitionInputValidator = v.union(
	v.object({
		to: v.literal('published'),
		at: v.number(),
		htmlContent: v.string(),
		htmlTranslations: v.optional(v.string()),
	}),
	v.object({ to: v.literal('draft'), at: v.number() }),
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────

export const LEGAL_EDGES: Record<
	EmailTemplateStatus,
	ReadonlySet<EmailTemplateStatus>
> = {
	draft: new Set<EmailTemplateStatus>(['published']),
	published: new Set<EmailTemplateStatus>(['draft']),
};

// ─── Effects ────────────────────────────────────────────────────────────────

type Effect =
	| {
			kind: 'audit_log';
			action: AuditAction;
			templateId: Id<'emailTemplates'>;
			userId: string;
			details: Record<string, string | number | boolean | null>;
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
};

// ─── Reducer ────────────────────────────────────────────────────────────────

function reduce(
	template: Doc<'emailTemplates'>,
	input: EmailTemplateTransitionInput,
	userId: string,
): ReducerResult {
	const from = template.status as EmailTemplateStatus;

	if (from === input.to) {
		// Idempotent — record the attempt via audit log, no patch.
		return {
			patch: {},
			effects: [
				{
					kind: 'audit_log',
					action: auditActionFor(input.to),
					templateId: template._id,
					userId,
					details: {
						previousStatus: from,
						newStatus: input.to,
						applied: 'recorded',
					},
				},
			],
			applied: 'recorded',
		};
	}

	const patch = buildPatch(input);
	const effects: Effect[] = [
		{
			kind: 'audit_log',
			action: auditActionFor(input.to),
			templateId: template._id,
			userId,
			details: {
				previousStatus: from,
				newStatus: input.to,
				applied: 'transitioned',
			},
		},
	];

	return { patch, effects, applied: 'transitioned' };
}

function auditActionFor(to: EmailTemplateStatus): AuditAction {
	switch (to) {
		case 'published':
			return 'email_template.published';
		case 'draft':
			return 'email_template.unpublished';
	}
}

function buildPatch(input: EmailTemplateTransitionInput): Record<string, unknown> {
	switch (input.to) {
		case 'published':
			return {
				status: 'published',
				htmlContent: input.htmlContent,
				htmlTranslations: input.htmlTranslations,
				publishedAt: input.at,
				updatedAt: input.at,
			};
		case 'draft':
			return {
				status: 'draft',
				publishedAt: undefined,
				updatedAt: input.at,
			};
	}
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
					resource: 'email_template',
					resourceId: effect.templateId,
					details: effect.details,
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
	template: Doc<'emailTemplates'>,
	input: EmailTemplateTransitionInput,
	userId: string,
): Promise<EmailTemplateTransitionOutcome> {
	const from = template.status as EmailTemplateStatus;
	const isLegal = LEGAL_EDGES[from].has(input.to);
	const isSelfLoop = from === input.to;

	if (!isLegal && !isSelfLoop) {
		return { ok: false, reason: 'illegal_edge', from, to: input.to };
	}

	const result = reduce(template, input, userId);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(
			template._id,
			result.patch as Partial<Doc<'emailTemplates'>>,
		);
	}
	await applyEffects(ctx, result.effects);

	return {
		ok: true,
		applied: result.applied,
		from,
		to: input.to,
		templateId: template._id,
	};
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Insert a new `emailTemplates` row at `draft`. The only insert site for
 * `emailTemplates` — used by `emails.create`, `organization.createForOrganization`,
 * and `organization.createFromPreset`.
 */
export const create = internalMutation({
	args: {
		name: v.string(),
		type: emailTemplateTypeValidator,
		subject: v.optional(v.string()),
		previewText: v.optional(v.string()),
		content: v.optional(v.string()),
		defaultLanguage: v.optional(v.string()),
		linkedBlockIds: v.optional(v.array(v.string())),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<EmailTemplateCreateOutcome> => {
		const now = Date.now();
		const defaultLanguage = args.defaultLanguage ?? 'en';
		const name = args.name.trim();
		const subject = args.subject?.trim() ?? '';
		const searchableText = buildSearchableText(name, subject);

		const templateId = await ctx.db.insert('emailTemplates', {
			name,
			subject,
			previewText: args.previewText?.trim(),
			content: args.content ?? '[]',
			type: args.type,
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
				action: 'email_template.created',
				templateId,
				userId: args.userId,
				details: {
					name,
					type: args.type,
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

		return { ok: true, templateId };
	},
});

/**
 * Apply an email-template status transition. The only writer of
 * `emailTemplates.status` and its companion fields. Atomic with: row
 * patch + audit-log row.
 *
 * Duplicate (`from === to`) returns `applied: 'recorded'` with an
 * audit-log row but no patch. Illegal transitions return
 * `{ ok: false, reason: 'illegal_edge' }` — never thrown.
 */
export const transition = internalMutation({
	args: {
		templateId: v.id('emailTemplates'),
		input: transitionInputValidator,
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<EmailTemplateTransitionOutcome> => {
		const template = await ctx.db.get(args.templateId);
		if (!template) return { ok: false, reason: 'template_not_found' };
		return await dispatch(ctx, template, args.input, args.userId);
	},
});

/**
 * Duplicate an email template. The copy lands at `draft` regardless of
 * the source's status; `linkedBlockIds` are copied and usage counts are
 * propagated.
 */
export const duplicate = internalMutation({
	args: {
		templateId: v.id('emailTemplates'),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<EmailTemplateDuplicateOutcome> => {
		const template = await ctx.db.get(args.templateId);
		if (!template) return { ok: false, reason: 'template_not_found' };

		const now = Date.now();
		const newName = `${template.name} (Copy)`;
		const searchableText = buildSearchableText(newName, template.subject);

		const newId = await ctx.db.insert('emailTemplates', {
			name: newName,
			subject: template.subject,
			previewText: template.previewText,
			content: template.content,
			htmlContent: template.htmlContent,
			type: template.type,
			status: 'draft',
			defaultLanguage: template.defaultLanguage,
			supportedLanguages: template.supportedLanguages,
			translations: template.translations,
			linkedBlockIds: template.linkedBlockIds,
			contentBlockVersion:
				template.contentBlockVersion ?? CURRENT_CONTENT_BLOCK_VERSION,
			rendererVersion: template.rendererVersion ?? CURRENT_RENDERER_VERSION,
			searchableText,
			createdAt: now,
			updatedAt: now,
		});

		const effects: Effect[] = [
			{
				kind: 'audit_log',
				action: 'email_template.duplicated',
				templateId: newId,
				userId: args.userId,
				details: {
					sourceTemplateId: args.templateId,
					name: newName,
					applied: 'transitioned',
				},
			},
		];
		if (template.linkedBlockIds && template.linkedBlockIds.length > 0) {
			effects.push({
				kind: 'update_block_usage_counts',
				previousIds: [],
				nextIds: template.linkedBlockIds,
			});
		}
		await applyEffects(ctx, effects);

		return { ok: true, templateId: newId };
	},
});

/**
 * Delete an email template. Emits an audit log and decrements the usage
 * counts of any saved blocks the template linked, so the block library's
 * "X uses" count stays accurate after a delete.
 */
export const remove = internalMutation({
	args: {
		templateId: v.id('emailTemplates'),
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<EmailTemplateRemoveOutcome> => {
		const template = await ctx.db.get(args.templateId);
		if (!template) return { ok: false, reason: 'template_not_found' };

		const name = template.name;
		await ctx.db.delete(args.templateId);

		const effects: Effect[] = [
			{
				kind: 'audit_log',
				action: 'email_template.deleted',
				templateId: args.templateId,
				userId: args.userId,
				details: {
					name,
					applied: 'transitioned',
				},
			},
		];
		if (template.linkedBlockIds && template.linkedBlockIds.length > 0) {
			effects.push({
				kind: 'update_block_usage_counts',
				previousIds: template.linkedBlockIds,
				nextIds: [],
			});
		}
		await applyEffects(ctx, effects);

		return { ok: true };
	},
});

// ─── Publish invariant guard ────────────────────────────────────────────────

/**
 * Refuse to mutate publishable content on a `published` row unless the
 * caller passes `forceWhilePublished: true`. Consumed by every mutation
 * in `emailTemplates/` that touches publishable content.
 *
 * The editor UX surfaces an "Unpublish to edit?" gate to the user;
 * setting `forceWhilePublished: true` is the explicit opt-in.
 */
export function assertEditableForPublishableChange(
	template: Doc<'emailTemplates'>,
	force?: boolean,
): void {
	if (template.status === 'published' && !force) {
		throwInvalidState(
			'Template is published. Pass forceWhilePublished: true or unpublish first.',
			{ action: 'unpublish' },
		);
	}
}
