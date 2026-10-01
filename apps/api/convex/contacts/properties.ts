import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireContactsManage } from './guards';
import { getOrThrow, throwAlreadyExists, throwInvalidState } from '../_utils/errors';
import { fieldTypeValidator } from '../lib/literalValidators';
import {
	isPropertyPendingDeletion,
	readPropertyDeletion,
	requestPropertyDeletion,
	type PropertyDeletionView,
} from './propertyDeletion';
import type { Doc } from '../_generated/dataModel';

type ListedProperty = Doc<'contactProperties'> & { deletion?: PropertyDeletionView | null };

// Query to list the contact properties. A property being deleted is left out
// (pickers must not offer it) unless the caller asks for it: the admin page
// shows it with its deletion progress.
export const listByOrganization = authedQuery({
	args: { includePendingDeletion: v.optional(v.boolean()) },
	handler: async (ctx, args): Promise<ListedProperty[]> => {
		const properties = await ctx.db.query('contactProperties').collect(); // bounded: custom property definitions (org-scale, few)
		if (!args.includePendingDeletion) {
			return properties.filter((property) => !isPropertyPendingDeletion(property));
		}
		return await Promise.all(
			properties.map(async (property) =>
				isPropertyPendingDeletion(property)
					? { ...property, deletion: await readPropertyDeletion(ctx, property._id) }
					: property
			)
		);
	},
});

// Mutation to create a new contact property
export const create = authedMutation({
	args: {
		key: v.string(),
		label: v.string(),
		type: fieldTypeValidator,
	},
	handler: async (ctx, args) => {
		await requireContactsManage(ctx);

		// Check if property with same key already exists
		const existing = await ctx.db
			.query('contactProperties')
			.withIndex('by_key', (q) => q.eq('key', args.key))
			.first();

		if (existing && isPropertyPendingDeletion(existing)) {
			throwInvalidState(
				'A property with this key is still being deleted; try again once it is gone'
			);
		}
		if (existing) {
			throwAlreadyExists('Property with this key already exists');
		}

		return await ctx.db.insert('contactProperties', {
			key: args.key,
			label: args.label,
			type: args.type,
			createdAt: Date.now(),
		});
	},
});

// Mutation to update a contact property
export const update = authedMutation({
	args: {
		propertyId: v.id('contactProperties'),
		label: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireContactsManage(ctx);

		const property = await getOrThrow(ctx, args.propertyId, 'Property');
		if (isPropertyPendingDeletion(property)) {
			throwInvalidState('This property is being deleted');
		}

		const updates: { label?: string } = {};
		if (args.label !== undefined) {
			updates.label = args.label;
		}

		await ctx.db.patch(args.propertyId, updates);
		return args.propertyId;
	},
});

// Mutation to delete a contact property and all its values. The values go in
// bounded batches (`propertyDeletion.ts`): the first batch runs here, so a small
// property is gone on return (`deleted`); a larger one stays listed as pending
// until its background job has removed the rest (`pending`). Repeating the call
// joins the job under way, or re-arms one that failed.
export const remove = authedMutation({
	args: { propertyId: v.id('contactProperties') },
	handler: async (ctx, args, session): Promise<'deleted' | 'pending'> => {
		await requireContactsManage(ctx);

		const property = await getOrThrow(ctx, args.propertyId, 'Property');
		return await requestPropertyDeletion(ctx, property, session.userId);
	},
});
