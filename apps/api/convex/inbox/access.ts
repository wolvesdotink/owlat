/**
 * Who may read the shared inbox.
 *
 * THE shared-inbox reader gate: a signed-in owner or admin. Every thread
 * query, the presence list and the raw-message signed URL ask it here, and so
 * does every module outside inbox/ that serves Team Inbox rows to a client
 * (scripts/check-query-authz.sh), so the rule changes in one place.
 *
 * CONVENTIONS asks for a named `<scope>:<verb>` permission rather than an
 * inline role compare, because a role compare obscures the capability being
 * checked. There is no `inbox:*` scope in `lib/sessionOrganization.ts` yet;
 * this is the one name to change when it arrives.
 *
 * Not a gate of its own: each caller still decides what refusal looks like on
 * its surface (an empty list, `null`, a throw). This only answers the question.
 */

import { internalQuery, type QueryCtx, type MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { components } from '../_generated/api';
import { throwUnauthenticated } from '../_utils/errors';
import {
	getBetterAuthSessionWithRole,
	getSingletonOrganizationId,
	hasPermission,
	requirePermission,
	type OrganizationRole,
} from '../lib/sessionOrganization';

/**
 * A resolved session is a shared-inbox reader when it is an owner or admin.
 *
 * A type guard, so the call sites keep the narrowing the inline comparison gave
 * them: past this check the session is non-null and its role is known, and the
 * handler can go on reading `session.userId` without a second null test.
 */
export function isSharedInboxReader<T extends { role: OrganizationRole | null }>(
	session: T | null
): session is T & { role: 'owner' | 'admin' } {
	return hasPermission(session?.role, 'organization:manage');
}

/**
 * The reader gate for an `authedAction`, which cannot read the session itself:
 * the action calls this through `ctx.runQuery`, inheriting its identity.
 * Throws `unauthenticated` without a session and `forbidden` for a caller who
 * is not a shared-inbox reader; returns `null` otherwise.
 */
export const assertSharedInboxReader = internalQuery({
	args: {},
	handler: async (ctx): Promise<null> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) throwUnauthenticated();
		requirePermission(
			isSharedInboxReader(session),
			'Only owners and admins can use the Team Inbox'
		);
		return null;
	},
});

/** Upper bound on member rows scanned when fanning a notice out to readers. */
const MAX_READER_SCAN = 200;

/**
 * The BetterAuth user ids of every shared-inbox reader (owner / admin member
 * of the singleton organization). Used when the agent needs a person and no
 * assignee names one — the notice fans out to the same people who see the
 * review queue. Bounded scan; an instance with more members than the bound
 * notifies the first page only.
 */
export async function listSharedInboxReaderIds(ctx: QueryCtx | MutationCtx): Promise<string[]> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'member',
		where: [{ field: 'organizationId', value: organizationId }],
		paginationOpts: { cursor: null, numItems: MAX_READER_SCAN },
	})) as { page?: Array<{ userId?: string; role?: string }> } | null;
	const ids: string[] = [];
	for (const member of result?.page ?? []) {
		if (!member.userId) continue;
		if (isSharedInboxReader({ role: (member.role ?? null) as OrganizationRole | null })) {
			ids.push(member.userId);
		}
	}
	return ids;
}

/**
 * Whether a knowledge entry was derived from Team Inbox mail, and so follows
 * the reader rule above: shown only to shared-inbox readers.
 *
 * Either marker is enough:
 *   - `sourceType: 'agent_extracted'` is what `extractFromMessage` stores for
 *     facts mined from an inbound Team Inbox message;
 *   - `threadId` points at a Team Inbox conversation (message extraction, and
 *     files linked to a thread). `updateEntry` cannot change it, and only a
 *     reader may set it on `createEntry`.
 * Entries from files, chat, imported Postbox mail and manual authoring carry
 * neither and keep their member-wide visibility. Only someone who can already
 * see an entry can edit its `sourceType`.
 */
export function isInboxDerivedKnowledge(
	entry: Pick<Doc<'knowledgeEntries'>, 'sourceType' | 'threadId'>
): boolean {
	return entry.sourceType === 'agent_extracted' || entry.threadId !== undefined;
}
