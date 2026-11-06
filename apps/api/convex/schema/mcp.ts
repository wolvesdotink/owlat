import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	mcpActionStatusValidator,
	mcpActionValidator,
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

	// A write a read-write client asked for, waiting for its owner to approve or
	// reject it in Owlat (`mcp/actions.ts`). Nothing in `action` runs before
	// that. Decided rows stay for the client to read the outcome, then the
	// retention sweep deletes them.
	mcpPendingActions: defineTable({
		organizationId: v.string(),
		clientId: v.id('mcpClients'),
		userId: v.string(),
		mailboxId: v.id('mailboxes'),
		action: mcpActionValidator,
		status: mcpActionStatusValidator,
		createdAt: v.number(),
		expiresAt: v.number(),
		decidedAt: v.optional(v.number()),
		// What an approved `create_draft` made, for `get_action_status`.
		resultDraftId: v.optional(v.id('mailDrafts')),
		// Why an approved action could not run, as the client and the owner read it.
		failureMessage: v.optional(v.string()),
	})
		.index('by_client_and_status', ['clientId', 'status'])
		.index('by_user_org_and_status', ['userId', 'organizationId', 'status', 'createdAt'])
		.index('by_status_and_expires', ['status', 'expiresAt'])
		.index('by_decided_at', ['decidedAt'])
		.index('by_user', ['userId']),
};

/** Wiped with the workspace and with the member: actions, then activity, then the clients. */
export const MCP_TABLES = ['mcpPendingActions', 'mcpClientActivity', 'mcpClients'] as const;
export type McpTable = (typeof MCP_TABLES)[number];
