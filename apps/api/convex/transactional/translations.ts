import { v } from 'convex/values';
import { transactionalMutation, transactionalQuery } from './_helpers';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';
import { assertEditableForPublishableChange } from '../lib/publishableEmail';
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
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage transactional email translations'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');
		assertEditableForPublishableChange(email, 'Transactional email', args.forceWhilePublished);

		await ctx.db.patch(
			args.id,
			addTranslationPatch(email, args.language, TRANSACTIONAL_TRANSLATABLE_FIELDS)
		);
		return args.id;
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
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage transactional email translations'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');
		assertEditableForPublishableChange(email, 'Transactional email', args.forceWhilePublished);

		await ctx.db.patch(
			args.id,
			updateTranslationPatch(email, args, TRANSACTIONAL_TRANSLATABLE_FIELDS)
		);
		return args.id;
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
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can manage transactional email translations'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');
		assertEditableForPublishableChange(email, 'Transactional email', args.forceWhilePublished);

		await ctx.db.patch(args.id, removeTranslationPatch(email, args.language));
		return args.id;
	},
});
