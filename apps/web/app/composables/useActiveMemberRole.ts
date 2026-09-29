import { computed, effectScope, watch, type EffectScope, type Ref } from 'vue';
import type { OrganizationRole } from '@owlat/shared/organizationPermissions';
import { getActiveMember } from '~/lib/auth-client';
import { logError } from '~/lib/runtimeLog';

/**
 * Map a better-auth role to the app's role. better-auth calls the editor
 * `member`; everything else is spelled the same.
 */
export function mapFromBetterAuthRole(role: string): OrganizationRole {
	if (role === 'member') return 'editor';
	return role as OrganizationRole;
}

/**
 * The key a role answer belongs to: who asked, in which organization. A role is
 * only "resolved" for the key it was looked up under, so a sign-in as someone
 * else or an organization switch makes it unknown again without anyone having to
 * remember to reset a flag.
 */
function roleKey(userId: string | null | undefined, organizationId: string | null): string | null {
	return userId && organizationId ? `${userId}|${organizationId}` : null;
}

interface RoleState {
	role: Ref<OrganizationRole | null>;
	resolvedFor: Ref<string | null>;
}

let roleScope: EffectScope | null = null;
// Bumped per lookup, so a slow answer for an earlier key never overwrites a
// newer one (an organization switch mid-request).
let lookupSeq = 0;

async function lookUpRole(state: RoleState, key: string): Promise<void> {
	const seq = ++lookupSeq;
	let role: OrganizationRole | null;
	try {
		const result = await getActiveMember();
		// No member back (better-auth answers FORBIDDEN / BAD_REQUEST when the
		// session names an organization the user is no longer in) is an answer
		// too: no role.
		const member = result?.data as { role?: string } | null | undefined;
		role = member?.role ? mapFromBetterAuthRole(member.role) : null;
	} catch (error) {
		logError('[useActiveMemberRole] failed to load the member role', error);
		// A failed refresh keeps the role this key already had. A failed first
		// lookup settles WITHOUT a role, so the admin guard fails closed to Home
		// instead of stalling for its whole timeout.
		role = state.resolvedFor.value === key ? state.role.value : null;
	}
	if (seq !== lookupSeq) return;
	state.role.value = role;
	state.resolvedFor.value = key;
}

/**
 * The signed-in member's role in the session's active organization.
 *
 * One small better-auth request (`/organization/get-active-member`) keyed on the
 * SESSION's active organization id, so it starts as soon as the session is known
 * and does not wait for the full-organization request, the member list or the
 * invitation list. Those lists are loaded only by the pages that show them
 * (`useOrganization().fetchMembers`).
 *
 * `isResolved` is what a guard waits on: true once the role for the current
 * user + organization has come back (with or without a role), and trivially
 * true when there is no active organization. The server checks the role on
 * every call regardless; this only decides what the client renders.
 *
 * The lookup runs in a DETACHED scope, opened once for the app's lifetime,
 * because the first caller may be a route guard after its `await`, where no
 * effect scope exists and a watcher would never be stopped.
 */
export function useActiveMemberRole() {
	const { user, activeOrganizationId } = useAuth();
	// Shared with `useOrganization().fetchMembers`, which also learns the role
	// when it loads the member list.
	const role = useState<OrganizationRole | null>('org-current-role', () => null);
	const resolvedFor = useState<string | null>('org-role-resolved-for', () => null);

	const currentKey = computed(() => roleKey(user.value?.id, activeOrganizationId.value));
	const isResolved = computed(
		() => currentKey.value === null || resolvedFor.value === currentKey.value
	);

	if (!roleScope) {
		const state: RoleState = { role, resolvedFor };
		roleScope = effectScope(true);
		roleScope.run(() => {
			// Its own session refs, not the caller's: those belong to the caller's
			// scope and stop with it.
			const session = useAuth();
			watch(
				() => roleKey(session.user.value?.id, session.activeOrganizationId.value),
				(key, previousKey) => {
					if (key === null) {
						lookupSeq++;
						role.value = null;
						resolvedFor.value = null;
						return;
					}
					// A different member or organization: the old role says nothing
					// about the new one, so drop it rather than render it meanwhile.
					if (previousKey !== undefined && previousKey !== key) role.value = null;
					void lookUpRole(state, key);
				},
				{ immediate: true }
			);
		});
	}

	/** Look the role up again, e.g. after this member's own role changed. */
	async function refresh(): Promise<void> {
		const key = currentKey.value;
		if (key === null) return;
		await lookUpRole({ role, resolvedFor }, key);
	}

	return { role, isResolved, refresh };
}

// Detached scopes outlive their callers and must be stopped on hot replacement.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		roleScope?.stop();
		roleScope = null;
	});
}
