/**
 * MCP clients: the per-member tokens an external AI client uses to read
 * Postbox mail, and the lookup that turns a presented token into a client.
 *
 * A member manages only their own clients. The plaintext token is returned
 * once, by `create`, and only its SHA-256 hash is kept.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { randomToken } from '../lib/randomToken';
import { rateLimiter } from '../lib/rateLimiter';
import { validateStringLength } from '../lib/inputGuards';
import { throwInvalidInput, throwNotFound } from '../_utils/errors';
import { hashApiKey } from '../auth/apiKeyAuth';
import { loadMcpEligibleMailboxes } from './access';
import { mcpMutation, mcpQuery } from './_helpers';
import { MCP_TOKEN_PREFIX } from './protocol';

const LABEL_MAX = 80;
const MAILBOXES_MAX = 10;
/** Alphanumeric characters after the prefix: about 256 random bits. */
const TOKEN_RANDOM_CHARS = 43;
/** Shown in Settings so the member can tell tokens apart. */
const TOKEN_PREFIX_SHOWN = MCP_TOKEN_PREFIX.length + 6;
/** `lastUsedAt` moves at most this often, so a busy client does not write per call. */
const LAST_USED_GRANULARITY_MS = 60_000;

/** A client row as Settings shows it: never the hash. */
function toPublicClient(
	client: Doc<'mcpClients'>,
	eligible: ReadonlyMap<Id<'mailboxes'>, Doc<'mailboxes'>>
) {
	return {
		_id: client._id,
		label: client.label,
		tokenPrefix: client.tokenPrefix,
		access: client.access,
		mailboxes: client.mailboxIds.map((mailboxId) => {
			const mailbox = eligible.get(mailboxId);
			// A mailbox the member lost access to stays listed, marked, so the
			// row explains why the client no longer sees it.
			return mailbox
				? { mailboxId, address: mailbox.address, isAvailable: true }
				: { mailboxId, address: null, isAvailable: false };
		}),
		createdAt: client.createdAt,
		...(client.lastUsedAt !== undefined ? { lastUsedAt: client.lastUsedAt } : {}),
		...(client.revokedAt !== undefined ? { revokedAt: client.revokedAt } : {}),
	};
}

// authz: self-scope — the caller's own clients, read by their userId.
// token-safe: projects through toPublicClient, which drops tokenHash.
export const list = mcpQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		const rows = await ctx.db
			.query('mcpClients')
			.withIndex('by_user_and_org', (q) =>
				q.eq('userId', session.userId).eq('organizationId', session.activeOrganizationId)
			)
			.order('desc')
			.take(100);
		const eligible = await loadMcpEligibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		const byId = new Map(eligible.map((mailbox) => [mailbox._id, mailbox]));
		return rows.map((row) => toPublicClient(row, byId));
	},
});

// all-members: any member may connect an AI client, and only to mailboxes they can already read.
export const create = mcpMutation({
	args: { label: v.string(), mailboxIds: v.array(v.id('mailboxes')) },
	handler: async (ctx, args, session) => {
		const label = args.label.trim();
		if (!label) throwInvalidInput('Name required');
		validateStringLength(label, LABEL_MAX, 'Name');
		const mailboxIds = [...new Set(args.mailboxIds)];
		if (mailboxIds.length === 0) throwInvalidInput('Choose at least one mailbox');
		if (mailboxIds.length > MAILBOXES_MAX) {
			throwInvalidInput(`Choose at most ${MAILBOXES_MAX} mailboxes`);
		}
		const eligible = new Set(
			(await loadMcpEligibleMailboxes(ctx, session.userId, session.activeOrganizationId)).map(
				(mailbox) => mailbox._id
			)
		);
		// The same answer for a missing mailbox and someone else's, so the
		// refusal does not confirm that an id exists.
		if (mailboxIds.some((id) => !eligible.has(id))) throwNotFound('Mailbox');

		const token = randomToken(TOKEN_RANDOM_CHARS, MCP_TOKEN_PREFIX);
		const clientId = await ctx.db.insert('mcpClients', {
			organizationId: session.activeOrganizationId,
			userId: session.userId,
			label,
			tokenHash: await hashApiKey(token),
			tokenPrefix: token.slice(0, TOKEN_PREFIX_SHOWN),
			access: 'read',
			mailboxIds,
			activityCount: 0,
			createdAt: Date.now(),
		});
		return { clientId, token };
	},
});

// authz: self-scope — a member revokes only their own client (client.userId === session.userId).
export const revoke = mcpMutation({
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
		if (client.revokedAt !== undefined) return;
		await ctx.db.patch(client._id, { revokedAt: Date.now() });
	},
});

/**
 * Turn a presented token into a client and spend one request from its rate
 * limit, in one transaction. A miss spends from the caller's per-IP failure
 * budget instead (the bucket the API-key verifier uses), so guessing tokens
 * is throttled. Whether the client may still read anything is decided per
 * call by `mcp/access.ts`; a revoked client stops here.
 */
export const authenticate = internalMutation({
	args: { tokenHash: v.string(), ip: v.string() },
	handler: async (ctx, args) => {
		const client = await ctx.db
			.query('mcpClients')
			.withIndex('by_token_hash', (q) => q.eq('tokenHash', args.tokenHash))
			.unique();
		if (!client || client.revokedAt !== undefined) {
			const failure = await rateLimiter.limit(ctx, 'apiKeyAuthFailure', { key: args.ip });
			return failure.ok
				? ({ ok: false, reason: 'invalid' } as const)
				: ({ ok: false, reason: 'rate_limited', retryAfter: failure.retryAfter ?? 1000 } as const);
		}
		const limit = await rateLimiter.limit(ctx, 'apiRequest', { key: client._id });
		if (!limit.ok) {
			return { ok: false, reason: 'rate_limited', retryAfter: limit.retryAfter ?? 1000 } as const;
		}
		const now = Date.now();
		if (client.lastUsedAt === undefined || now - client.lastUsedAt >= LAST_USED_GRANULARITY_MS) {
			await ctx.db.patch(client._id, { lastUsedAt: now });
		}
		return { ok: true, clientId: client._id } as const;
	},
});
