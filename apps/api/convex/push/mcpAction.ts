/**
 * The push for an AI client's write that waits for this person's approval
 * (`mcp/actions.ts`). Resolved when the sender runs, so an action decided,
 * lapsed or cancelled in the meantime, or a server switched off, notifies
 * nobody.
 *
 * Not a Convex function module; `push/dispatch.ts` calls it.
 */

import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { mcpActionPayload, type PushPayload } from './copy';

/** The action lapses after a day; a push held longer than half of that is stale. */
const MCP_ACTION_TTL_SECONDS = 12 * 3600;

export async function resolveMcpActionPush(
	ctx: QueryCtx,
	userId: string,
	actionId: Id<'mcpPendingActions'>,
	prefs: { locale: string | undefined; isPrivate: boolean }
): Promise<{
	payload: PushPayload;
	rule: { kind: 'unless-nothing' };
	ttlSeconds: number;
} | null> {
	const row = await ctx.db.get(actionId);
	if (!row || row.userId !== userId || row.status !== 'pending') return null;
	if (!(await isFeatureEnabled(ctx, 'mail.mcp'))) return null;
	const client = await ctx.db.get(row.clientId);
	if (!client || client.revokedAt !== undefined) return null;
	return {
		payload: mcpActionPayload(
			{ actionId: row._id, clientLabel: client.label, tool: row.action.tool },
			prefs.locale,
			prefs.isPrivate
		),
		// Like a handover: the person is the only one who can unblock it.
		rule: { kind: 'unless-nothing' },
		ttlSeconds: MCP_ACTION_TTL_SECONDS,
	};
}
