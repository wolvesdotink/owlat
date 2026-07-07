import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { throwNotFound, throwAlreadyExists } from '../_utils/errors';

// Query to list all contact properties
export const listByOrganization = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db.query('contactProperties').collect(); // bounded: custom property definitions (org-scale, few)
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
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can manage contacts'
		);

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
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can manage contacts'
		);

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

// Batch size for cascading a property's value deletion. Small enough to keep
// each mutation well under Convex's per-transaction document limit.
const PROPERTY_CASCADE_BATCH = 200;

// Delete one batch of a property's values. Returns true once none remain (the
// caller may then delete the property itself).
async function drainPropertyValues(
	ctx: MutationCtx,
	propertyId: Id<'contactProperties'>
): Promise<boolean> {
	const batch = await ctx.db
		.query('contactPropertyValues')
		.withIndex('by_property', (q) => q.eq('propertyId', propertyId))
		.take(PROPERTY_CASCADE_BATCH);
	for (const value of batch) {
		await ctx.db.delete(value._id);
	}
	return batch.length < PROPERTY_CASCADE_BATCH;
}

// Mutation to delete a contact property and all its values
export const remove = authedMutation({
	args: { propertyId: v.id('contactProperties') },
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can manage contacts'
		);

		const property = await ctx.db.get(args.propertyId);
		if (!property) {
			throwNotFound('Property');
		}

		// Drain the property's values first so it never outlives a dangling value.
		// A property with few values finishes inline; a large one hands off to a
		// self-rescheduling internal mutation that deletes the property once drained.
		const drained = await drainPropertyValues(ctx, args.propertyId);
		if (drained) {
			await ctx.db.delete(args.propertyId);
		} else {
			await ctx.scheduler.runAfter(0, internal.contacts.properties.finishRemoveProperty, {
				propertyId: args.propertyId,
			});
		}
	},
});

// Continuation of `remove` for properties with more values than one batch:
// drain another batch, reschedule until empty, then delete the property itself.
export const finishRemoveProperty = internalMutation({
	args: { propertyId: v.id('contactProperties') },
	handler: async (ctx, args) => {
		const drained = await drainPropertyValues(ctx, args.propertyId);
		if (!drained) {
			await ctx.scheduler.runAfter(0, internal.contacts.properties.finishRemoveProperty, args);
			return;
		}
		const property = await ctx.db.get(args.propertyId);
		if (property) {
			await ctx.db.delete(args.propertyId);
		}
	},
});

// Mutation to create default properties
export const createDefaultProperties = authedMutation({
	args: {},
	handler: async (ctx) => {
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can manage contacts'
		);

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
