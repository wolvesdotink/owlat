import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { getMutationContext, hasPermission, requirePermission } from '../lib/sessionOrganization';
import { throwNotFound, throwAlreadyExists } from '../_utils/errors';

// Query to list all contact properties
export const listByOrganization = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db
			.query('contactProperties')
			.collect();
	},
});

// Query to get a single contact property by ID
export const get = authedQuery({
	args: { propertyId: v.id('contactProperties') },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.propertyId);
	},
});

// Query to get a contact property by key
export const getByKey = authedQuery({
	args: {
		key: v.string(),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query('contactProperties')
			.withIndex('by_key', (q) => q.eq('key', args.key))
			.first();
	},
});

// Mutation to create a new contact property
export const create = authedMutation({
	args: {
		key: v.string(),
		label: v.string(),
		type: v.union(
			v.literal('string'),
			v.literal('number'),
			v.literal('boolean'),
			v.literal('date')
		),
	},
	handler: async (ctx, args) => {
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'contacts:manage'), 'Only owners and admins can manage contacts');

		// Check if property with same key already exists
		const existing = await ctx.db
			.query('contactProperties')
			.withIndex('by_key', (q) => q.eq('key', args.key))
			.first();

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
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'contacts:manage'), 'Only owners and admins can manage contacts');

		const property = await ctx.db.get(args.propertyId);
		if (!property) {
			throwNotFound('Property');
		}

		const updates: { label?: string } = {};
		if (args.label !== undefined) {
			updates.label = args.label;
		}

		await ctx.db.patch(args.propertyId, updates);
		return args.propertyId;
	},
});

// Mutation to delete a contact property and all its values
export const remove = authedMutation({
	args: { propertyId: v.id('contactProperties') },
	handler: async (ctx, args) => {
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'contacts:manage'), 'Only owners and admins can manage contacts');

		const property = await ctx.db.get(args.propertyId);
		if (!property) {
			throwNotFound('Property');
		}

		// Delete all property values associated with this property
		const values = await ctx.db
			.query('contactPropertyValues')
			.withIndex('by_property', (q) => q.eq('propertyId', args.propertyId))
			.collect();

		for (const value of values) {
			await ctx.db.delete(value._id);
		}

		// Delete the property itself
		await ctx.db.delete(args.propertyId);
	},
});

// Mutation to create default properties
export const createDefaultProperties = authedMutation({
	args: {},
	handler: async (ctx) => {
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'contacts:manage'), 'Only owners and admins can manage contacts');

		const defaultProperties = [
			{ key: 'first_name', label: 'First Name', type: 'string' as const },
			{ key: 'last_name', label: 'Last Name', type: 'string' as const },
			{ key: 'company', label: 'Company', type: 'string' as const },
		];

		const createdIds: string[] = [];

		for (const prop of defaultProperties) {
			// Check if property already exists
			const existing = await ctx.db
				.query('contactProperties')
				.withIndex('by_key', (q) => q.eq('key', prop.key))
				.first();

			if (!existing) {
				const id = await ctx.db.insert('contactProperties', {
					key: prop.key,
					label: prop.label,
					type: prop.type,
					createdAt: Date.now(),
				});
				createdIds.push(id);
			}
		}

		return createdIds;
	},
});
