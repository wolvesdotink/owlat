import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	mcpActivityOutcomeValidator,
	mcpClientAccessValidator,
	mcpToolNameValidator,
} from '../lib/validators/mcp';

/**
 * External AI clients connected to Postbox over MCP (`mcp/`), and what each
 * one did.
 *
 * A client belongs to one member. Its token reaches only the mailboxes listed
 * on the row, and only while that member can still open them in the web app:
 * every call re-checks membership and mailbox access, so the row never grants
 * more than its owner holds at that moment.
 */
export const mcpTables = {
	mcpClients: defineTable({
		organizationId: v.string(),
		userId: v.string(),
		label: v.string(),
		// SHA-256 (hex) of the bearer token. The token carries about 256 random bits,
		// so a fast hash is enough; the plaintext is shown once and never stored.
		tokenHash: v.string(),
		// The first characters of the token, so the member can tell tokens apart.
		tokenPrefix: v.string(),
		access: mcpClientAccessValidator,
		mailboxIds: v.array(v.id('mailboxes')),
		// Rows in `mcpClientActivity` for this client; the oldest is dropped
		// once it passes the cap in `mcp/activity.ts`.
		activityCount: v.number(),
		createdAt: v.number(),
		lastUsedAt: v.optional(v.number()),
		revokedAt: v.optional(v.number()),
	})
		.index('by_token_hash', ['tokenHash'])
		.index('by_user_and_org', ['userId', 'organizationId']),

	// One row per tool call, shown to the client's owner in Settings. It holds
	// what the client asked for (the search text, the thread) and how many
	// results it got, never mail content.
	mcpClientActivity: defineTable({
		clientId: v.id('mcpClients'),
		userId: v.string(),
		tool: mcpToolNameValidator,
		outcome: mcpActivityOutcomeValidator,
		mailboxId: v.optional(v.id('mailboxes')),
		threadId: v.optional(v.id('mailThreads')),
		query: v.optional(v.string()),
		resultCount: v.optional(v.number()),
		at: v.number(),
	})
		.index('by_client_and_at', ['clientId', 'at'])
		.index('by_user', ['userId']),
};

/** Wiped with the workspace and with the member, activity first. */
export const MCP_TABLES = ['mcpClientActivity', 'mcpClients'] as const;
export type McpTable = (typeof MCP_TABLES)[number];
