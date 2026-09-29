import type { MaybeRefOrGetter } from 'vue';
import { authClient } from '~/lib/auth-client';
import {
	clearResolvedPostboxBodies,
	setResolvedPostboxBodyScope,
	type PostboxBodyClient,
} from './postboxBodyResolver';

/**
 * Decides when the shared resolved-body cache (postboxBodyResolver) is thrown
 * away. The list's read-ahead no longer clears it on unmount, so this is what
 * keeps one context's decrypted mail from being served in another:
 *
 *  - a mailbox switch, or a different user or organization, drops it through
 *    the scope key (set while the Postbox page is mounted);
 *  - any session change (sign-in, sign-out, organization switch, account
 *    update) drops it through better-auth's session signal, wherever the user
 *    is in the app. That listener is registered once per Convex client and
 *    lives as long as the client, like the Convex auth listener does.
 */

const sessionListenerClients = new WeakSet<PostboxBodyClient>();

function clearOnSessionChange(client: PostboxBodyClient): void {
	if (sessionListenerClients.has(client)) return;
	sessionListenerClients.add(client);
	// nanostores' subscribe calls the listener once right away with the current
	// value; that first call is registration, not a session change.
	let registered = false;
	authClient.$store.listen('$sessionSignal', () => {
		if (registered) clearResolvedPostboxBodies(client);
	});
	registered = true;
}

export function postboxBodyScopeKey(
	userId: string | null,
	organizationId: string | null,
	mailboxId: string | null
): string | null {
	if (!userId || !mailboxId) return null;
	return `${userId}|${organizationId ?? ''}|${mailboxId}`;
}

export function usePostboxBodyCacheScope(mailboxId: MaybeRefOrGetter<string | null>): void {
	const client = useConvex();
	if (!client) return;
	clearOnSessionChange(client);

	const { user, activeOrganizationId } = useAuth();
	watch(
		() => [user.value?.id ?? null, activeOrganizationId.value ?? null, toValue(mailboxId)] as const,
		([userId, organizationId, currentMailboxId]) => {
			if (!userId) {
				clearResolvedPostboxBodies(client);
				return;
			}
			// A null mailbox is the mailbox query still loading: keep the cache
			// until the real next mailbox is known.
			const key = postboxBodyScopeKey(userId, organizationId, currentMailboxId);
			if (key) setResolvedPostboxBodyScope(client, key);
		},
		{ immediate: true }
	);
}
