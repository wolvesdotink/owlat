/**
 * What each MCP client did: one row per tool call, shown to the client's owner
 * in Settings next to the token.
 *
 * The log keeps the newest {@link ACTIVITY_PER_CLIENT_MAX} calls per client;
 * each new row past the cap drops the oldest, so the table stays bounded
 * without a sweep.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { throwNotFound } from '../_utils/errors';
import {
	mcpActivityOutcomeValidator,
	mcpToolNameValidator,
	type McpActivityOutcome,
	type McpToolName,
} from '../lib/validators/mcp';
import { mcpQuery } from './_helpers';

export const ACTIVITY_PER_CLIENT_MAX = 200;
/** The search text is kept for the owner to read back, cut to this length. */
const QUERY_LOG_MAX = 200;

// authz: self-scope — only the client's owner reads its log (client.userId === session.userId).
// token-safe: returns activity rows, which carry no token material.
export const list = mcpQuery({
	args: { clientId: v.id('mcpClients') },
	handler: async (ctx, args, session) => {
		const client = await ctx.db.get(args.clientId);
		if (
			!client ||
			client.userId !== session.userId ||
			client.organizationId !== session.activeOrganizationId
		) {
			throwNotFound('Client');
		}
		const rows = await ctx.db
			.query('mcpClientActivity')
			.withIndex('by_client_and_at', (q) => q.eq('clientId', client._id))
			.order('desc')
			.take(50);
		return rows.map((row) => ({
			_id: row._id,
			tool: row.tool,
			outcome: row.outcome,
			at: row.at,
			...(row.mailboxId !== undefined ? { mailboxId: row.mailboxId } : {}),
			...(row.query !== undefined ? { query: row.query } : {}),
			...(row.resultCount !== undefined ? { resultCount: row.resultCount } : {}),
		}));
	},
});

export type ActivityEntry = {
	tool: McpToolName;
	outcome: McpActivityOutcome;
	mailboxId?: Id<'mailboxes'>;
	threadId?: Id<'mailThreads'>;
	query?: string;
	resultCount?: number;
};

/** Add one row to a client's log, dropping the oldest past the cap. */
export async function appendActivity(
	ctx: MutationCtx,
	client: Doc<'mcpClients'>,
	entry: ActivityEntry
): Promise<void> {
	const { query, ...rest } = entry;
	await ctx.db.insert('mcpClientActivity', {
		clientId: client._id,
		userId: client.userId,
		...rest,
		...(query !== undefined ? { query: query.slice(0, QUERY_LOG_MAX) } : {}),
		at: Date.now(),
	});
	// Re-read: an earlier append in the same transaction already moved the count.
	const current = (await ctx.db.get(client._id)) ?? client;
	let count = current.activityCount + 1;
	if (count > ACTIVITY_PER_CLIENT_MAX) {
		const oldest = await ctx.db
			.query('mcpClientActivity')
			.withIndex('by_client_and_at', (q) => q.eq('clientId', client._id))
			.order('asc')
			.first();
		if (oldest) {
			await ctx.db.delete(oldest._id);
			count -= 1;
		}
	}
	await ctx.db.patch(client._id, { activityCount: count });
}

export const record = internalMutation({
	args: {
		clientId: v.id('mcpClients'),
		tool: mcpToolNameValidator,
		outcome: mcpActivityOutcomeValidator,
		mailboxId: v.optional(v.id('mailboxes')),
		threadId: v.optional(v.id('mailThreads')),
		query: v.optional(v.string()),
		resultCount: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const client = await ctx.db.get(args.clientId);
		if (!client) return;
		const { clientId: _clientId, ...entry } = args;
		await appendActivity(ctx, client, entry);
	},
});
