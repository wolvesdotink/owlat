import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { buildSearchableText } from '../lib/queryHelpers';
import {
	getOrThrow,
	throwAlreadyExists,
	throwInternal,
	throwInvalidInput,
	throwInvalidState,
	throwNotFound,
} from '../_utils/errors';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { dataVariablesSchemaValidator } from '../lib/convexValidators';
import { assertEditableForPublishableChange } from './lifecycle';
import { applyUsageCountDelta } from '../emailBlocks/module';

// Data variable type for schema definition
export type DataVariableType = 'string' | 'number' | 'boolean' | 'date';

export interface DataVariableSchema {
	[key: string]: DataVariableType;
}

/**
 * List all transactional emails for an organization with optional filtering
 */
export const list = authedQuery({
	args: {
		status: v.optional(
			v.union(v.literal('draft'), v.literal('published'), v.literal('pending_review'))
		),
		search: v.optional(v.string()),
		sortBy: v.optional(v.union(v.literal('updatedAt'), v.literal('createdAt'), v.literal('name'))),
		sortOrder: v.optional(v.union(v.literal('asc'), v.literal('desc'))),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'transactional');
		let transactionalEmails = await ctx.db.query('transactionalEmails').collect(); // bounded: transactional-email templates (org-scale library)

		if (args.status) {
			transactionalEmails = transactionalEmails.filter((e) => e.status === args.status);
		}

		// Apply search filter if provided
		if (args.search) {
			const searchLower = args.search.toLowerCase();
			transactionalEmails = transactionalEmails.filter(
				(email) =>
					email.name.toLowerCase().includes(searchLower) ||
					email.slug.toLowerCase().includes(searchLower) ||
					email.subject.toLowerCase().includes(searchLower)
			);
		}

		// Sort based on sortBy and sortOrder
		const sortBy = args.sortBy || 'updatedAt';
		const sortOrder = args.sortOrder || 'desc';

		return transactionalEmails.sort((a, b) => {
			let comparison = 0;
			if (sortBy === 'name') {
				comparison = a.name.localeCompare(b.name);
			} else if (sortBy === 'createdAt') {
				comparison = a.createdAt - b.createdAt;
			} else {
				comparison = a.updatedAt - b.updatedAt;
			}
			return sortOrder === 'asc' ? comparison : -comparison;
		});
	},
});

/**
 * Get a single transactional email by ID
 */
export const get = authedQuery({
	args: { id: v.id('transactionalEmails') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'transactional');
		return await ctx.db.get(args.id);
	},
});

/**
 * Get a transactional email by organization and slug (for API lookups)
 */
export const getBySlug = authedQuery({
	args: {
		slug: v.string(),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query('transactionalEmails')
			.withIndex('by_slug', (q) => q.eq('slug', args.slug))
			.first();
	},
});

/**
 * Count transactional emails by status for an organization
 */
export const countByStatus = authedQuery({
	args: {},
	handler: async (ctx) => {
		const allEmails = await ctx.db.query('transactionalEmails').collect(); // bounded: transactional-email templates (org-scale library)

		return {
			total: allEmails.length,
			draft: allEmails.filter((e) => e.status === 'draft').length,
			published: allEmails.filter((e) => e.status === 'published').length,
			pending_review: allEmails.filter((e) => e.status === 'pending_review').length,
		};
	},
});

/**
 * Create a new transactional email
 */
export const create = authedMutation({
	args: {
		name: v.string(),
		slug: v.string(),
		subject: v.optional(v.string()),
		content: v.optional(v.string()),
		dataVariablesSchema: v.optional(dataVariablesSchemaValidator),
		defaultLanguage: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'transactionalEmails'>> => {
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can create transactional emails'
		);
		const outcome = await ctx.runMutation(internal.transactional.lifecycle.create, {
			name: args.name,
			slug: args.slug,
			subject: args.subject,
			content: args.content,
			dataVariablesSchema: args.dataVariablesSchema,
			defaultLanguage: args.defaultLanguage,
			userId: 'system:transactional_api',
		});

		if (!outcome.ok) {
			if (outcome.reason === 'invalid_slug_format') {
				throwInvalidInput(
					"Slug must be lowercase alphanumeric with hyphens (e.g., 'welcome-email', 'order-confirmation')"
				);
			}
			if (outcome.reason === 'slug_already_exists') {
				throwAlreadyExists(`A transactional email with slug "${args.slug}" already exists`);
			}
		}
		// At this point outcome must be ok=true.
		if (!outcome.ok) {
			// unreachable — exhaustive narrowing for the compiler.
			throwInternal('Unexpected outcome');
		}
		return outcome.emailId;
	},
});

/**
 * Update a transactional email
 */
export const update = authedMutation({
	args: {
		id: v.id('transactionalEmails'),
		name: v.optional(v.string()),
		slug: v.optional(v.string()),
		subject: v.optional(v.string()),
		content: v.optional(v.string()),
		htmlContent: v.optional(v.string()),
		dataVariablesSchema: v.optional(dataVariablesSchemaValidator),
		showUnsubscribe: v.optional(v.boolean()),
		// Multi-language support fields
		defaultLanguage: v.optional(v.string()),
		supportedLanguages: v.optional(v.array(v.string())),
		translations: v.optional(v.string()),
		htmlTranslations: v.optional(v.string()),
		// IDs of saved blocks linked in this email
		linkedBlockIds: v.optional(v.array(v.string())),
		// File attachments as JSON string
		attachments: v.optional(v.string()),
		// Allow editing publishable content on a `published` row; default `false`.
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'transactional');
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can update transactional emails'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');

		assertEditableForPublishableChange(email, args.forceWhilePublished);

		// If updating slug, check for uniqueness
		if (args.slug && args.slug !== email.slug) {
			const existing = await ctx.db
				.query('transactionalEmails')
				.withIndex('by_slug', (q) => q.eq('slug', args.slug!))
				.first();

			if (existing) {
				throwAlreadyExists(`A transactional email with slug "${args.slug}" already exists`);
			}

			// Validate slug format
			const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
			if (!slugRegex.test(args.slug)) {
				throwInvalidInput(
					"Slug must be lowercase alphanumeric with hyphens (e.g., 'welcome-email', 'order-confirmation')"
				);
			}
		}

		const updates: Partial<{
			name: string;
			slug: string;
			subject: string;
			content: string;
			htmlContent: string;
			dataVariablesSchema: Record<string, DataVariableType>;
			showUnsubscribe: boolean;
			defaultLanguage: string;
			supportedLanguages: string[];
			translations: string;
			htmlTranslations: string;
			linkedBlockIds: string[];
			attachments: string;
			searchableText: string;
			updatedAt: number;
		}> = {
			updatedAt: Date.now(),
		};

		if (args.name !== undefined) updates.name = args.name;
		if (args.slug !== undefined) updates.slug = args.slug;
		if (args.subject !== undefined) updates.subject = args.subject;
		if (args.content !== undefined) updates.content = args.content;
		if (args.htmlContent !== undefined) updates.htmlContent = args.htmlContent;
		if (args.dataVariablesSchema !== undefined)
			updates.dataVariablesSchema = args.dataVariablesSchema;
		if (args.showUnsubscribe !== undefined) updates.showUnsubscribe = args.showUnsubscribe;
		if (args.defaultLanguage !== undefined) updates.defaultLanguage = args.defaultLanguage;
		if (args.supportedLanguages !== undefined) updates.supportedLanguages = args.supportedLanguages;
		if (args.translations !== undefined) updates.translations = args.translations;
		if (args.htmlTranslations !== undefined) updates.htmlTranslations = args.htmlTranslations;
		if (args.linkedBlockIds !== undefined) {
			updates.linkedBlockIds = args.linkedBlockIds;
			// A normal editor save patches the row directly (it does NOT route
			// through the lifecycle's create/duplicate effect), so keep saved-block
			// usageCount in sync here by diffing the previous vs. new linked set.
			await applyUsageCountDelta(ctx, email.linkedBlockIds ?? [], args.linkedBlockIds);
		}
		if (args.attachments !== undefined) updates.attachments = args.attachments;

		// Update searchableText if any searchable field changed
		if (args.name !== undefined || args.subject !== undefined || args.slug !== undefined) {
			updates.searchableText = buildSearchableText(
				args.name ?? email.name,
				args.subject ?? email.subject,
				args.slug ?? email.slug
			);
		}

		await ctx.db.patch(args.id, updates);
		return args.id;
	},
});

/**
 * Publish a transactional email (make it available via API)
 */
export const publish = authedMutation({
	args: {
		id: v.id('transactionalEmails'),
		htmlContent: v.string(), // Required to ensure HTML is generated
		// Pre-rendered HTML for each translation language
		htmlTranslations: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'transactional');
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can publish transactional emails'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');

		if (email.status === 'published') {
			throwInvalidState('Transactional email is already published');
		}

		const outcome = await ctx.runMutation(internal.transactional.lifecycle.transition, {
			emailId: args.id,
			input: {
				to: 'published',
				at: Date.now(),
				htmlContent: args.htmlContent,
				htmlTranslations: args.htmlTranslations,
			},
			userId: 'system:transactional_api',
		});

		if (!outcome.ok) {
			if (outcome.reason === 'email_not_found') {
				throwNotFound('Transactional email');
			}
			throwInvalidState(`Cannot publish transactional email: ${outcome.reason}`);
		}

		return args.id;
	},
});

/**
 * Unpublish a transactional email (return to draft status)
 */
export const unpublish = authedMutation({
	args: { id: v.id('transactionalEmails') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'transactional');
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can unpublish transactional emails'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');

		if (email.status === 'draft') {
			throwInvalidState('Transactional email is already a draft');
		}

		const outcome = await ctx.runMutation(internal.transactional.lifecycle.transition, {
			emailId: args.id,
			input: { to: 'draft', at: Date.now() },
			userId: 'system:transactional_api',
		});

		if (!outcome.ok) {
			if (outcome.reason === 'email_not_found') {
				throwNotFound('Transactional email');
			}
			throwInvalidState(`Cannot unpublish transactional email: ${outcome.reason}`);
		}

		return args.id;
	},
});

/**
 * Duplicate a transactional email
 */
export const duplicate = authedMutation({
	args: { id: v.id('transactionalEmails') },
	handler: async (ctx, args): Promise<Id<'transactionalEmails'>> => {
		await assertFeatureEnabled(ctx, 'transactional');
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can duplicate transactional emails'
		);
		const outcome = await ctx.runMutation(internal.transactional.lifecycle.duplicate, {
			emailId: args.id,
			userId: 'system:transactional_api',
		});

		if (!outcome.ok) {
			throwNotFound('Transactional email');
		}
		return outcome.emailId;
	},
});

/**
 * Delete a transactional email
 */
export const remove = authedMutation({
	args: { id: v.id('transactionalEmails') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'transactional');
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can delete transactional emails'
		);
		const outcome = await ctx.runMutation(internal.transactional.lifecycle.remove, {
			emailId: args.id,
			userId: 'system:transactional_api',
		});

		if (!outcome.ok) {
			throwNotFound('Transactional email');
		}
		return args.id;
	},
});

/**
 * Update data variables schema
 */
export const updateSchema = authedMutation({
	args: {
		id: v.id('transactionalEmails'),
		dataVariablesSchema: dataVariablesSchemaValidator,
		forceWhilePublished: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'transactional');
		await requireOrgPermission(
			ctx,
			'templates:manage',
			'Only owners and admins can update transactional email schema'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');

		assertEditableForPublishableChange(email, args.forceWhilePublished);

		// Validate schema format
		const schema = args.dataVariablesSchema;
		const validTypes: DataVariableType[] = ['string', 'number', 'boolean', 'date'];

		for (const [key, type] of Object.entries(schema)) {
			// Validate key format
			if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
				throwInvalidInput(
					`Invalid variable name "${key}". Must start with a letter and contain only letters, numbers, and underscores.`
				);
			}
			// Validate type
			if (!validTypes.includes(type as DataVariableType)) {
				throwInvalidInput(
					`Invalid type "${type}" for variable "${key}". Must be one of: ${validTypes.join(', ')}`
				);
			}
		}

		await ctx.db.patch(args.id, {
			dataVariablesSchema: args.dataVariablesSchema,
			updatedAt: Date.now(),
		});

		return args.id;
	},
});
