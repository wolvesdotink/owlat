import { v } from 'convex/values';
import { emailTemplateTypeValidator } from '../lib/convexValidators';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { paginationOptsValidator } from 'convex/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { listResources } from '../lib/listing';
import { emailTemplateListing } from './listing';
import { getOrThrow, throwNotFound, throwInvalidState } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { recordListingCounter } from '../lib/listingCounters';
import {
	assertEditableForPublishableChange,
	buildEditablePatch,
	publishedHtml,
} from '../lib/publishableEmail';
import { loadEmailTheme } from '../lib/publishableEmailRender';
import { brandedNewEmailContent } from '../workspaces/brandKit';
import { captureTemplateVersion } from './versions';
import { assertContentRevision } from '../lib/contentRevision';
import { rendererVersionArg } from '../lib/rendererVersion';
import { loadCoeditSave, markCoeditSaved } from '../emailCoediting/save';

// Query to get a single email template by ID
export const get = authedQuery({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
		const template = await ctx.db.get(args.templateId);
		return template;
	},
});

// Mutation to update an email template
export const update = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		name: v.optional(v.string()),
		subject: v.optional(v.string()),
		previewText: v.optional(v.string()),
		content: v.optional(v.string()),
		// Accepted for older clients and ignored: the server renders the HTML
		// from the stored blocks (lib/publishableEmail.ts buildEditablePatch).
		htmlContent: v.optional(v.string()),
		// text/plain alternative shipped with the html. `plainTextContent` is the
		// effective body (override when the author wrote one, else the body the
		// renderer generated from `content`); `plainTextOverride` records the
		// author's own text so the editor can tell the two apart. An EMPTY
		// `plainTextOverride` is the editor's "revert to generated" signal and
		// clears the column.
		plainTextContent: v.optional(v.string()),
		plainTextOverride: v.optional(v.string()),
		// Multi-language support fields
		defaultLanguage: v.optional(v.string()),
		supportedLanguages: v.optional(v.array(v.string())),
		translations: v.optional(v.string()),
		// Ignored, like htmlContent: rendered from the translation overlays.
		htmlTranslations: v.optional(v.string()),
		// Ignored, like htmlContent: the stored HTML is stamped with this
		// server's renderer (lib/rendererVersion.ts).
		rendererVersion: rendererVersionArg,
		// IDs of saved blocks linked in this template
		linkedBlockIds: v.optional(v.array(v.string())),
		// Allow editing publishable content on a `published` row; default `false`.
		forceWhilePublished: v.optional(v.boolean()),
		// The `contentRevision` the caller's payload was built on. When given, the
		// write is refused with `conflict` if the row has moved on since.
		expectedContentRevision: v.optional(v.number()),
		// The co-editing session version the caller has seen. When given and the
		// template has a live session, the session's draft is saved instead of
		// the payload's blocks and shared fields (emailCoediting/save.ts).
		coeditVersion: v.optional(v.number()),
	},
	handler: async (ctx, rawArgs) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can update email templates'
		);
		const coedit = await loadCoeditSave(
			ctx,
			{ type: 'emailTemplate', id: rawArgs.templateId },
			rawArgs.coeditVersion
		);
		const args = coedit ? { ...rawArgs, ...coedit.overrides } : rawArgs;

		const template = await getOrThrow(ctx, args.templateId, 'Email template');

		assertEditableForPublishableChange(template, 'Template', args.forceWhilePublished);
		assertContentRevision(template, args.expectedContentRevision);

		const updates = {
			...(await buildEditablePatch(ctx, template, args, {
				noun: 'Template',
				variableType: 'personalization',
				searchableFields: ['name', 'subject'],
			})),
			...(args.previewText !== undefined && { previewText: args.previewText.trim() }),
		};

		await ctx.db.patch(args.templateId, updates);
		if (coedit) await markCoeditSaved(ctx, coedit, updates.contentRevision);

		// Persisted version history (the editor's undo stack dies with the tab).
		// Snapshot the POST-patch row, in this transaction, so a rolled-back save
		// leaves no version claiming content that was never stored. Identical
		// consecutive saves dedupe inside `captureTemplateVersion`.
		await captureTemplateVersion(ctx, {
			template: { ...template, ...updates },
			trigger: 'save',
			userId: session.userId,
		});

		// Audit the content/metadata edit — the documented email_template.updated
		// action was never emitted from this handler.
		const changedFields = Object.keys(updates).filter(
			(k) => k !== 'updatedAt' && k !== 'contentRevision'
		);
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'email_template.updated',
			resource: 'email_template',
			resourceId: args.templateId,
			details: { changedFields: changedFields.join(', ') },
		});

		// The revision this write stored; the editor builds its next save on it.
		return { templateId: args.templateId, contentRevision: updates.contentRevision };
	},
});

// Mutation to publish an email template
export const publish = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		// Ignored: publish uses the row's own HTML, or renders a never-rendered
		// row from its blocks (see `publishedHtml`). Still accepted so older
		// clients, which send the row's HTML back, keep working.
		htmlContent: v.optional(v.string()),
		// Ignored, like htmlContent.
		htmlTranslations: v.optional(v.string()),
		// Ignored, like htmlContent: the stored HTML is stamped with this
		// server's renderer (lib/rendererVersion.ts).
		rendererVersion: rendererVersionArg,
		// The `contentRevision` the caller last saw. When given, a row that has
		// moved on is refused with `conflict`, so what goes live is the version
		// the caller was looking at.
		expectedContentRevision: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can publish email templates'
		);

		const template = await ctx.db.get(args.templateId);
		if (!template) throwNotFound('Email template');
		assertContentRevision(template, args.expectedContentRevision, 'publish');
		const html = publishedHtml(template, {
			variableType: 'personalization',
			theme: await loadEmailTheme(ctx),
		});

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.transition, {
			templateId: args.templateId,
			input: { to: 'published', at: Date.now(), ...html },
			userId: session.userId,
		});

		if (!outcome.ok) {
			if (outcome.reason === 'template_not_found') {
				throwNotFound('Email template');
			}
			throwInvalidState(`Cannot publish template: ${outcome.reason}`);
		}

		// Record what was published, even when the content is byte-identical to
		// the last save — "this is the version that went live" is the event the
		// history exists to answer.
		const published = await ctx.db.get(args.templateId);
		if (published) {
			await captureTemplateVersion(ctx, {
				template: published,
				trigger: 'publish',
				userId: session.userId,
			});
		}

		return args.templateId;
	},
});

// Mutation to unpublish an email template (revert to draft)
export const unpublish = authedMutation({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can unpublish email templates'
		);

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.transition, {
			templateId: args.templateId,
			input: { to: 'draft', at: Date.now() },
			userId: session.userId,
		});

		if (!outcome.ok) {
			if (outcome.reason === 'template_not_found') {
				throwNotFound('Email template');
			}
			throwInvalidState(`Cannot unpublish template: ${outcome.reason}`);
		}

		return args.templateId;
	},
});

// Mutation to duplicate an email template
export const duplicate = authedMutation({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args): Promise<Id<'emailTemplates'>> => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can duplicate email templates'
		);

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.duplicate, {
			templateId: args.templateId,
			userId: session.userId,
		});

		if (!outcome.ok) {
			throwNotFound('Email template');
		}

		return outcome.templateId;
	},
});

// Mutation to delete an email template
export const remove = authedMutation({
	args: { templateId: v.id('emailTemplates') },
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can delete email templates'
		);

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.remove, {
			templateId: args.templateId,
			userId: session.userId,
		});

		if (!outcome.ok) {
			throwNotFound('Email template');
		}
	},
});

// Mutation to change template type
export const changeType = authedMutation({
	args: {
		templateId: v.id('emailTemplates'),
		type: emailTemplateTypeValidator,
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can change template type'
		);

		const template = await getOrThrow(ctx, args.templateId, 'Email template');

		assertEditableForPublishableChange(template, 'Template', args.forceWhilePublished);

		await ctx.db.patch(args.templateId, {
			type: args.type,
			updatedAt: Date.now(),
		});
		await recordListingCounter(ctx, 'templateType', template, { ...template, type: args.type });

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'email_template.updated',
			resource: 'email_template',
			resourceId: args.templateId,
			details: { changedFields: 'type', type: args.type },
		});

		return args.templateId;
	},
});

// ==========================================
// SESSION-BASED QUERIES AND MUTATIONS (US-405)
// These derive auth from the BetterAuth session.
// ==========================================

/**
 * List email templates.
 */
// List email templates (paginated, uniform { page, … } contract). Search is
// relevance-ordered; otherwise updatedAt-descending with index-native type
// filtering. The old shell `.collect()`-ed the whole table per call. ADR-0037.
export const list = authedQuery({
	args: {
		type: v.optional(emailTemplateTypeValidator),
		status: v.optional(v.union(v.literal('draft'), v.literal('published'))),
		search: v.optional(v.string()),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) =>
		listResources(ctx.db, emailTemplateListing, {
			search: args.search,
			filters: { type: args.type, status: args.status },
			paginationOpts: args.paginationOpts,
		}),
});

/**
 * Create a new email template.
 */
export const create = authedMutation({
	args: {
		name: v.string(),
		type: emailTemplateTypeValidator,
		subject: v.optional(v.string()),
		previewText: v.optional(v.string()),
		content: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'emailTemplates'>> => {
		const session = await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can create email templates'
		);

		const outcome = await ctx.runMutation(internal.emailTemplates.lifecycle.create, {
			name: args.name,
			type: args.type,
			subject: args.subject,
			previewText: args.previewText,
			// A blank email starts with the brand kit's logo and footer.
			content: args.content ?? (await brandedNewEmailContent(ctx, undefined)),
			userId: session.userId,
		});

		return outcome.templateId;
	},
});
