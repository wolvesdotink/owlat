import { effectScope, type EffectScope } from 'vue';
import type { OrganizationRole } from '@owlat/shared/organizationPermissions';
import {
	listMembers as listOrgMembers,
	listInvitations as listOrgInvitations,
	updateOrganization as updateOrg,
	getFullOrganization as getFullOrg,
} from '~/lib/auth-client';
import { mapFromBetterAuthRole } from './useActiveMemberRole';
import {
	organizationTranslator,
	setRosterRefreshAfterSwitch,
	useOrganizationSession,
} from './useOrganizationSession';
import type { OrganizationInvitation, OrganizationMember } from './organization/roster';
import { useOrganizationMemberActions } from './organization/useOrganizationMemberActions';
import { useOrganizationInvitations } from './organization/useOrganizationInvitations';

export {
	planOwnershipTransfer,
	type Organization,
	type OrganizationInvitation,
	type OrganizationMember,
	type PendingMailboxInput,
} from './organization/roster';

// Defined in `@owlat/shared/organizationPermissions` alongside the permission
// map the Convex gates enforce, so the role vocabulary cannot drift between the
// two sides. Re-exported because the web app imports it from here.
export type { OrganizationRole };

// Module-level inflight tracking for fetch deduplication
let inflightFetch: Promise<void> | null = null;
let inflightOrgId: string | null = null;

// Time-based members cache to reduce redundant auth requests
let lastMembersFetchAt = 0;
let lastMembersFetchOrgId: string | null = null;
const MEMBERS_CACHE_TTL_MS = 60_000; // 60 seconds

// Module-level flag — resets on HMR (unlike useState which persists)
let watchSetUp = false;
// Whether any surface has asked for the member and invitation lists. Nothing
// loads them at boot: the role comes from `useActiveMemberRole`, and only the
// pages that show a roster call `fetchMembers`. Once one has, an organization
// switch refreshes the lists it is holding.
let membersWanted = false;

let membersScope: EffectScope | null = null;

/**
 * Composable for managing BetterAuth organization membership.
 * Uses shared state (useState) so all callers share the same data and
 * only one set of HTTP requests is made per organization switch.
 * The active organization and switching come from `useOrganizationSession`.
 */
export function useOrganization() {
	const t = organizationTranslator();
	// Built here, not inside the async bodies below. Those run after an `await`,
	// where there is no effect scope and no component instance — so a `useAuth()`
	// there would leak whatever it subscribes to and silently take the
	// no-instance branch of its translator.
	const auth = useAuth();
	const { user: sessionUser, activeOrganizationId: sessionOrganizationId } = auth;
	const { organization, organizationId, organizations, activeOrganizationError, setActive } =
		useOrganizationSession(auth);

	// Shared reactive state via useState — all instances share the same refs
	const members = useState<OrganizationMember[]>('org-members', () => []);
	const invitations = useState<OrganizationInvitation[]>('org-invitations', () => []);
	const isLoadingMembers = useState<boolean>('org-loading-members', () => false);
	// Whether the member-list fetch has SETTLED at least once for this
	// organization. Only roster pages care; the guards wait on the role from
	// `useActiveMemberRole`, which no longer depends on the lists.
	const hasResolvedMembers = useState<boolean>('org-members-resolved', () => false);
	// Non-null once a members/invitations fetch fails, so the team page can render
	// an explicit error state (with a retry) instead of an ambiguous empty list.
	const membersError = useState<string | null>('org-members-error', () => null);
	// Owned by `useActiveMemberRole` (same key); `fetchMembers` also writes it
	// when a loaded roster shows this member's role.
	const currentMemberRole = useState<OrganizationRole | null>('org-current-role', () => null);

	const isLoading = computed(() => {
		// Only track our own loading state (members/invitations fetch).
		// Don't rely on BetterAuth's isPending — it can get stuck when the
		// nanostores atom's shallowRef doesn't trigger after SSR hydration.
		// The session-level authPending in useOrganizationContext already gates
		// the initial loading state.
		return isLoadingMembers.value;
	});

	// Permission checks
	const canManageMembers = computed(() => {
		return currentMemberRole.value === 'owner' || currentMemberRole.value === 'admin';
	});

	const isOwner = computed(() => currentMemberRole.value === 'owner');

	/**
	 * Fetch organization members and invitations.
	 * Deduplicates concurrent requests for the same org.
	 */
	async function fetchMembers(options?: { force?: boolean }) {
		membersWanted = true;
		// The session names the organization before better-auth's separate
		// full-organization request has answered; a page mounting in that window
		// must still get its roster.
		const orgId = organizationId.value ?? sessionOrganizationId.value;
		if (!orgId) return;

		// Skip fetch if cached for the same org and within TTL
		if (
			!options?.force &&
			members.value.length > 0 &&
			lastMembersFetchOrgId === orgId &&
			Date.now() - lastMembersFetchAt < MEMBERS_CACHE_TTL_MS
		) {
			return;
		}

		// If there's already an inflight request for this org, reuse it
		if (inflightFetch && inflightOrgId === orgId) {
			return inflightFetch;
		}

		isLoadingMembers.value = true;
		membersError.value = null;

		const doFetch = async () => {
			try {
				// Fetch members and invitations in parallel
				const [membersResult, invitationsResult] = await Promise.all([
					listOrgMembers({
						query: {
							organizationId: orgId,
						},
					}),
					listOrgInvitations({
						query: {
							organizationId: orgId,
						},
					}),
				]);

				if (membersResult.data) {
					// Map BetterAuth roles to our app roles (member -> editor)
					members.value = membersResult.data.members.map((m: Record<string, unknown>) => ({
						...m,
						role: mapFromBetterAuthRole(m['role'] as string),
					})) as OrganizationMember[];

					// A fresher answer for the current user's role, when the roster
					// shows them. Not finding them (a roster page beyond the first
					// page) says nothing; `useActiveMemberRole` owns the role.
					const currentMember = sessionUser.value?.id
						? members.value.find((m) => m.userId === sessionUser.value?.id)
						: undefined;
					if (currentMember) currentMemberRole.value = currentMember.role;
				}

				if (invitationsResult.data) {
					// Filter to only show pending invitations and map roles (member -> editor)
					invitations.value = (invitationsResult.data as Array<Record<string, unknown>>)
						.filter((inv) => inv['status'] === 'pending')
						.map((inv) => ({
							...inv,
							role: mapFromBetterAuthRole(inv['role'] as string),
						})) as OrganizationInvitation[];
				}

				lastMembersFetchAt = Date.now();
				lastMembersFetchOrgId = orgId;
			} catch (error) {
				// Surface a fixed, human message so the team page shows a retryable
				// error state instead of an ambiguous empty list — never leak a raw
				// "Failed to fetch"-grade string into user-facing copy.
				console.error('[useOrganization] failed to load team members', error);
				membersError.value = t('shared.useOrganization.errors.membersLoadFailed');
			} finally {
				isLoadingMembers.value = false;
				// Settled — success or failure. A failed fetch must still release
				// the guards, or an unreachable backend wedges every admin route.
				hasResolvedMembers.value = true;
				inflightFetch = null;
				inflightOrgId = null;
			}
		};

		inflightOrgId = orgId;
		inflightFetch = doFetch();
		return inflightFetch;
	}
	const { remove, updateRole, transferOwnership } = useOrganizationMemberActions({
		t,
		organizationId,
		members,
		sessionUserId: () => sessionUser.value?.id,
		fetchMembers,
	});
	const { invite, cancelInvite, resendInvite } = useOrganizationInvitations({
		t,
		organizationId,
		fetchMembers,
	});

	/**
	 * Update the organization name or slug
	 */
	async function update(data: { name?: string; slug?: string; logo?: string }) {
		if (!organizationId.value) {
			throw new Error(t('shared.useOrganization.errors.noActiveOrganization'));
		}

		const result = await updateOrg({
			organizationId: organizationId.value,
			data,
		});

		if (result.error) {
			throw new Error(
				result.error.message || t('shared.useOrganization.errors.updateOrganizationFailed')
			);
		}

		return result.data;
	}

	/**
	 * Get full organization details including members
	 */
	async function getFullOrganization() {
		if (!organizationId.value) {
			throw new Error(t('shared.useOrganization.errors.noActiveOrganization'));
		}

		const result = await getFullOrg({
			query: {
				organizationId: organizationId.value,
			},
		});

		if (result.error) {
			throw new Error(
				result.error.message || t('shared.useOrganization.errors.getOrganizationFailed')
			);
		}

		return result.data;
	}

	// Single watch — only the first instance sets it up to avoid duplicate fetchMembers.
	// It no longer loads the lists at boot: only once a page has asked for them.
	// Uses module-level flag (not useState) so it resets on HMR, allowing the watch to be re-created.
	//
	// It belongs to a DETACHED scope, not to whichever caller happened to be
	// first: registered on a component's scope, that component unmounting would
	// stop the app's ONLY members watcher and no later organization switch would
	// refetch the member list for anybody.
	if (!watchSetUp) {
		watchSetUp = true;
		// A switch refreshes the lists only once a page has asked for them.
		setRosterRefreshAfterSwitch(async () => {
			if (membersWanted) await fetchMembers({ force: true });
		});
		membersScope = effectScope(true);
		membersScope.run(() => {
			watch(
				organizationId,
				async (newId) => {
					if (newId) {
						if (!membersWanted) return;
						try {
							await fetchMembers();
						} catch {
							// Fetch failed silently
						}
					} else {
						members.value = [];
						invitations.value = [];
						// Re-arm: the next organization's lists are unknown again. The
						// role is not reset here; `useActiveMemberRole` owns it and
						// keys it on the session.
						hasResolvedMembers.value = false;
					}
				},
				{ immediate: true }
			);
		});
	}

	return {
		// State
		organization,
		organizationId,
		organizations,
		members,
		invitations,
		currentMemberRole,
		isLoading,
		isLoadingMembers,
		hasResolvedMembers,
		activeOrganizationError,
		membersError,

		// Permission checks
		canManageMembers,
		isOwner,

		// Actions
		fetchMembers,
		invite,
		remove,
		updateRole,
		transferOwnership,
		cancelInvite,
		resendInvite,
		setActive,
		update,
		getFullOrganization,
	};
}

// Detached scopes outlive their callers and must be stopped on hot replacement.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		membersScope?.stop();
		membersScope = null;
		watchSetUp = false;
	});
}
