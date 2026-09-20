/**
 * Who may read the shared inbox.
 *
 * The rule is "a signed-in owner or admin", and it was spelled as the same
 * inline role comparison in eleven places across `inbox/` — every thread query,
 * the presence list, and the raw-message signed URL. CONVENTIONS asks for a
 * named `<scope>:<verb>` permission instead, because an inline role compare
 * obscures the capability being checked; there is no `inbox:*` scope in
 * `lib/sessionOrganization.ts` today, so this gives the eleven sites one name
 * in the meantime and one place to change when the scope arrives.
 *
 * Not a gate of its own: each caller still decides what refusal looks like on
 * its surface (an empty list, `null`, a throw). This only answers the question.
 */

import type { OrganizationRole } from '../lib/sessionOrganization';

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
