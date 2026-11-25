/**
 * What the `/api/v1/saved-blocks` routes read and write (`savedBlocksHttp.ts`),
 * in the public contract's shape.
 *
 * Writes go through the Saved block (module) (`emailBlocks/module.ts`), the
 * same writer the dashboard uses: the content is sanitised, an update's
 * content change reaches every email that links the block (and a published
 * email's new HTML is scanned before it goes live, in the rerender pool), and
 * the audit log names the API key as the actor.
 */

import { v } from 'convex/values';
import type { SavedBlock, SavedBlockSummary } from '@owlat/public-contract';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { throwInternal, throwNotFound } from '../_utils/errors';
import { paginateClientCursor } from '../lib/pagination';
import { rateLimiter } from '../lib/rateLimiter';
import { parseContentBlocks } from '../emailBlocks/consumers';
import { API_KEY_ACTOR } from './transactionalEmails';

const iso = (ms: number) => new Date(ms).toISOString();

function toSummary(row: Doc<'emailBlocks'>): SavedBlockSummary {
	return {
		id: row._id,
		name: row.name,
		description: row.description ?? null,
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	};
}

function toSavedBlock(row: Doc<'emailBlocks'>): SavedBlock {
	return {
		...toSummary(row),
		blocks: parseContentBlocks(row.content) as SavedBlock['blocks'],
	};
}

export const listForApi = internalQuery({
	args: { limit: v.number(), cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, args) => {
		const page = await paginateClientCursor(ctx.db.query('emailBlocks').order('asc'), {
			numItems: args.limit,
			cursor: args.cursor,
		});
		return {
			data: page.page.map(toSummary),
			pagination: {
				limit: args.limit,
				cursor: page.isDone ? null : page.continueCursor,
				isDone: page.isDone,
			},
		};
	},
});

export const getForApi = internalQuery({
	args: { blockId: v.id('emailBlocks') },
	handler: async (ctx, args): Promise<SavedBlock | null> => {
		const block = await ctx.db.get(args.blockId);
		return block ? toSavedBlock(block) : null;
	},
});

type WriteOutcome =
	| { ok: true; block: SavedBlock }
	| { ok: false; reason: 'rate_limited'; retryAfterSeconds: number };

async function spendWriteToken(
	ctx: MutationCtx,
	keyId: Id<'apiKeys'>
): Promise<{ ok: true } | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number }> {
	const { ok, retryAfter } = await rateLimiter.limit(ctx, 'apiTemplateWrite', { key: keyId });
	if (ok) return { ok: true };
	return {
		ok: false,
		reason: 'rate_limited',
		retryAfterSeconds: Math.ceil((retryAfter ?? 1000) / 1000),
	};
}

async function reread(ctx: MutationCtx, blockId: Id<'emailBlocks'>): Promise<SavedBlock> {
	const row = await ctx.db.get(blockId);
	if (!row) throwInternal('The written saved block was not found');
	return toSavedBlock(row);
}

/** The fields of a write: `content` is the sanitised blocks as stored JSON. */
const fields = {
	name: v.string(),
	description: v.string(),
	content: v.string(),
};

export const createForApi = internalMutation({
	args: { keyId: v.id('apiKeys'), ...fields },
	handler: async (ctx, args): Promise<WriteOutcome> => {
		const token = await spendWriteToken(ctx, args.keyId);
		if (!token.ok) return token;
		const outcome = await ctx.runMutation(internal.emailBlocks.module.create, {
			name: args.name,
			...(args.description ? { description: args.description } : {}),
			content: args.content,
			userId: API_KEY_ACTOR,
		});
		return { ok: true, block: await reread(ctx, outcome.blockId) };
	},
});

export const updateForApi = internalMutation({
	args: { keyId: v.id('apiKeys'), blockId: v.id('emailBlocks'), ...fields },
	handler: async (ctx, args): Promise<WriteOutcome> => {
		const token = await spendWriteToken(ctx, args.keyId);
		if (!token.ok) return token;
		const outcome = await ctx.runMutation(internal.emailBlocks.module.update, {
			blockId: args.blockId,
			// A write replaces every field: an empty description removes it.
			patch: { name: args.name, description: args.description, content: args.content },
			userId: API_KEY_ACTOR,
		});
		if (!outcome.ok) throwNotFound('Saved block');
		return { ok: true, block: await reread(ctx, args.blockId) };
	},
});
