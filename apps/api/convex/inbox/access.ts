/**
 * Who may read the shared inbox.
 *
 * THE shared-inbox reader gate: a signed-in owner or admin. Every thread
 * query, the presence list and the raw-message signed URL ask it here, so the
 * rule changes in one place.
 *
 * CONVENTIONS asks for a named `<scope>:<verb>` permission rather than an
 * inline role compare, because a role compare obscures the capability being
 * checked. There is no `inbox:*` scope in `lib/sessionOrganization.ts` yet;
 * this is the one name to change when it arrives.
 *
 * Not a gate of its own: each caller still decides what refusal looks like on
 * its surface (an empty list, `null`, a throw). This only answers the question.
 */

import type { QueryCtx, MutationCtx } from '../_generated/server';
import { components } from '../_generated/api';
import { getSingletonOrganizationId, type OrganizationRole } from '../lib/sessionOrganization';

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
	return session?.role === 'owner' || session?.role === 'admin';
}

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
