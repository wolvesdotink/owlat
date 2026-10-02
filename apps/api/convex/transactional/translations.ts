import { v } from 'convex/values';
import { transactionalMutation, transactionalQuery } from './_helpers';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';
import {
	assertEditableForPublishableChange,
	withRenderedTranslations,
} from '../lib/publishableEmail';
import { assertContentRevision } from '../lib/contentRevision';
import { rendererVersionArg } from '../lib/rendererVersion';
import {
	addTranslationPatch,
	removeTranslationPatch,
	resolveForLanguage,
	TRANSACTIONAL_TRANSLATABLE_FIELDS,
	updateTranslationPatch,
} from '../lib/emailTranslations';

/**
 * Get transactional email content for a specific language
 * Returns the content for the requested language, falling back to default language if not available
 */
export const getForLanguage = transactionalQuery({
	args: {
		id: v.id('transactionalEmails'),
		language: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const email = await ctx.db.get(args.id);
		if (!email) {
			return null;
		}

		return {
			...email,
			...resolveForLanguage(email, args.language, TRANSACTIONAL_TRANSLATABLE_FIELDS),
		};
	},
});

/**
 * Add a new language translation to a transactional email
 * Copies translatable text from default language as a starting point
 */
export const addTranslation = transactionalMutation({
	args: {
		id: v.id('transactionalEmails'),
		language: v.string(),
		// Ignored: the server renders every language's delivery HTML from the
		// stored overlays in this write (lib/publishableEmail.ts). Still accepted
		// so older clients keep working.
		htmlContent: v.optional(v.string()),
		// Ignored, like htmlContent.
		rendererVersion: rendererVersionArg,
		forceWhilePublished: v.optional(v.boolean()),
		// The `contentRevision` the caller built this write on. When given, the
		// write is refused with `conflict` if the row has moved on since.
		expectedContentRevision: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage transactional email translations'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');
		assertEditableForPublishableChange(email, 'Transactional email', args.forceWhilePublished);
		assertContentRevision(email, args.expectedContentRevision);

		const patch = await withRenderedTranslations(
			ctx,
			email,
			addTranslationPatch(email, args.language, TRANSACTIONAL_TRANSLATABLE_FIELDS),
			'data'
		);
		await ctx.db.patch(args.id, patch);
		// The revision this write stored; the next write builds on it.
		return { id: args.id, contentRevision: patch.contentRevision };
	},
});

/**
 * Update a specific language translation
 * For non-default languages, only updates translatable text (subject, block text)
 */
export const updateTranslation = transactionalMutation({
	args: {
		id: v.id('transactionalEmails'),
		language: v.string(),
		subject: v.optional(v.string()),
		blocks: v.optional(v.string()), // JSON string of Record<blockId, TranslatableBlockContent>
		// Ignored: the server renders every language's delivery HTML from the
		// stored overlays in this write (lib/publishableEmail.ts). Still accepted
		// so older clients keep working.
		htmlContent: v.optional(v.string()),
		// Ignored, like htmlContent.
		rendererVersion: rendererVersionArg,
		forceWhilePublished: v.optional(v.boolean()),
		// The `contentRevision` the caller built this write on. When given, the
		// write is refused with `conflict` if the row has moved on since.
		expectedContentRevision: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage transactional email translations'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');
		assertEditableForPublishableChange(email, 'Transactional email', args.forceWhilePublished);
		assertContentRevision(email, args.expectedContentRevision);

		const patch = await withRenderedTranslations(
			ctx,
			email,
			updateTranslationPatch(email, args, TRANSACTIONAL_TRANSLATABLE_FIELDS),
			'data'
		);
		await ctx.db.patch(args.id, patch);
		// The revision this write stored; the next write builds on it.
		return { id: args.id, contentRevision: patch.contentRevision };
	},
});

/**
 * Remove a language translation from a transactional email
 */
export const removeTranslation = transactionalMutation({
	args: {
		id: v.id('transactionalEmails'),
		language: v.string(),
		forceWhilePublished: v.optional(v.boolean()),
		// The `contentRevision` the caller built this write on. When given, the
		// write is refused with `conflict` if the row has moved on since.
		expectedContentRevision: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage transactional email translations'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');
		assertEditableForPublishableChange(email, 'Transactional email', args.forceWhilePublished);
		assertContentRevision(email, args.expectedContentRevision);

		const patch = await withRenderedTranslations(
			ctx,
			email,
			removeTranslationPatch(email, args.language),
			'data'
		);
		await ctx.db.patch(args.id, patch);
		// The revision this write stored; the next write builds on it.
		return { id: args.id, contentRevision: patch.contentRevision };
	},
});
