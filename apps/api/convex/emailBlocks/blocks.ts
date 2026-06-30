/**
 * Saved block (public surface) — thin shells that delegate row writes
 * to the **Saved block (module)** at `emailBlocks/module.ts`, plus the
 * read queries (`list`, `get`, `getStatsByTeam`, `getRecentByTeam`)
 * unchanged from the pre-ADR-0023 `emailBlocks.ts`.
 *
 * The legacy `incrementUsage` mutation is gone — zero callers, and the
 * canonical writer of `emailBlocks.usageCount` is now the lifecycle's
 * `update_block_usage_counts` effect routed through the module.
 *
 * Per ADR-0023.
 */

import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { getMutationContext, requirePermission, hasPermission } from '../lib/sessionOrganization';
import { throwNotFound } from '../_utils/errors';

// Userless audit attribution — saved-block mutations historically have
// no session check (mirrors the pre-deepening behavior). Audit logs
// still fire so the surface is observable.
const SYSTEM_USER_ID = 'system:email_block_api';

// ─── Content parsing for `blockCount` denormalization in reads ──────────────

interface SingleBlockContent {
	type: string;
	content: unknown;
}

interface MultiBlockContent {
	blocks: Array<{ id: string; type: string; content: unknown }>;
}

type ParsedBlockContent = SingleBlockContent | MultiBlockContent;

function isMultiBlockContent(content: ParsedBlockContent): content is MultiBlockContent {
	return 'blocks' in content && Array.isArray(content.blocks);
}

function getBlockCount(contentJson: string): number {
	try {
		const parsed = JSON.parse(contentJson) as ParsedBlockContent;
		if (isMultiBlockContent(parsed)) {
			return parsed.blocks.length;
		}
		if (parsed && typeof parsed === 'object' && 'type' in parsed && 'content' in parsed) {
			return 1;
		}
		return 0;
	} catch {
		return 0;
	}
}

// ─── Read queries (unchanged) ───────────────────────────────────────────────

export const get = authedQuery({
	args: { blockId: v.id('emailBlocks') },
	handler: async (ctx, args) => {
		const block = await ctx.db.get(args.blockId);
		if (!block) return null;
		return {
			...block,
			blockCount: getBlockCount(block.content),
		};
	},
});

export const getStatsByTeam = authedQuery({
	args: {},
	handler: async (ctx) => {
		const blocks = await ctx.db
			.query('emailBlocks')
			.collect();
		// bounded: emailBlocks is intrinsically small (one row per saved block)
		return {
			total: blocks.length,
		};
	},
});

export const getRecentByTeam = authedQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 5;
		const blocks = await ctx.db
			.query('emailBlocks')
			.collect();
		// bounded: emailBlocks is intrinsically small (one row per saved block)

		blocks.sort((a, b) => b.updatedAt - a.updatedAt);

		return blocks.slice(0, limit).map((block) => ({
			...block,
			blockCount: getBlockCount(block.content),
		}));
	},
});

export const list = authedQuery({
	args: {
		search: v.optional(v.string()),
		sortBy: v.optional(v.union(v.literal('recent'), v.literal('mostUsed'), v.literal('name'))),
	},
	handler: async (ctx, args) => {
		let blocks = await ctx.db
			.query('emailBlocks')
			.collect();
		// bounded: emailBlocks is intrinsically small (one row per saved block)

		if (args.search) {
			const search = args.search.toLowerCase().trim();
			blocks = blocks.filter((b) => {
				const name = b.name.toLowerCase();
				const description = (b.description || '').toLowerCase();
				return name.includes(search) || description.includes(search);
			});
		}

		const sortBy = args.sortBy || 'recent';
		switch (sortBy) {
			case 'mostUsed':
				blocks.sort((a, b) => b.usageCount - a.usageCount);
				break;
			case 'name':
				blocks.sort((a, b) => a.name.localeCompare(b.name));
				break;
			case 'recent':
			default:
				blocks.sort((a, b) => b.updatedAt - a.updatedAt);
				break;
		}

		return blocks.map((block) => ({
			...block,
			blockCount: getBlockCount(block.content),
		}));
	},
});

// ─── Write mutations — thin shells that delegate to the module ──────────────

/**
 * Create a saved block via the module. Replaces the pre-ADR-0023
 * direct insert that bypassed the audit log.
 */
export const create = authedMutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		content: v.string(),
	},
	handler: async (ctx, args): Promise<Id<'emailBlocks'>> => {
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can create saved blocks');
		const outcome = await ctx.runMutation(internal.emailBlocks.module.create, {
			name: args.name,
			description: args.description,
			content: args.content,
			userId: SYSTEM_USER_ID,
		});
		return outcome.blockId;
	},
});

/**
 * Update name / description / content. Delegates to the module — the
 * module classifies the change kind and emits the right propagation
 * effects (content → propagate_content + schedule_rerender;
 * name → propagate_name; description-only → audit_log).
 */
export const update = authedMutation({
	args: {
		blockId: v.id('emailBlocks'),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		content: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'emailBlocks'>> => {
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can update saved blocks');
		const outcome = await ctx.runMutation(internal.emailBlocks.module.update, {
			blockId: args.blockId,
			patch: {
				name: args.name,
				description: args.description,
				content: args.content,
			},
			userId: SYSTEM_USER_ID,
		});
		if (!outcome.ok) {
			throwNotFound('Email block');
		}
		return args.blockId;
	},
});

/**
 * Duplicate a saved block. Delegates to the module so the clone fires
 * the `email_block.duplicated` audit log.
 */
export const duplicate = authedMutation({
	args: { blockId: v.id('emailBlocks') },
	handler: async (ctx, args): Promise<Id<'emailBlocks'>> => {
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can duplicate saved blocks');
		const outcome = await ctx.runMutation(internal.emailBlocks.module.duplicate, {
			blockId: args.blockId,
			userId: SYSTEM_USER_ID,
		});
		if (!outcome.ok) {
			throwNotFound('Email block');
		}
		return outcome.blockId;
	},
});

/**
 * Delete a saved block. Delegates to the module; the module detaches
 * the block from every consumer row (strips `savedBlockRef` + the
 * `linkedBlockIds` entry) before the row is deleted.
 */
export const remove = authedMutation({
	args: { blockId: v.id('emailBlocks') },
	handler: async (ctx, args): Promise<void> => {
		const { role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'templates:manage'), 'Only owners and admins can delete saved blocks');
		const outcome = await ctx.runMutation(internal.emailBlocks.module.remove, {
			blockId: args.blockId,
			userId: SYSTEM_USER_ID,
		});
		if (!outcome.ok) {
			throwNotFound('Email block');
		}
	},
});
