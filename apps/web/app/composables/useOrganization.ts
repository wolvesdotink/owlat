import { api } from '@owlat/api';
import {
	useActiveOrganization,
	useListOrganizations,
	listMembers as listOrgMembers,
	listInvitations as listOrgInvitations,
	inviteMember as inviteOrgMember,
	removeMember as removeOrgMember,
	updateMemberRole as updateOrgMemberRole,
	cancelInvitation as cancelOrgInvitation,
	setActiveOrganization,
	updateOrganization as updateOrg,
	getFullOrganization as getFullOrg,
} from '~/lib/auth-client';

export interface PendingMailboxInput {
	localpart: string;
	domain: string;
	displayName?: string;
}

export type OrganizationRole = 'owner' | 'admin' | 'editor';

/**
 * Plan the two role changes that make up an ownership transfer.
 *
 * Owlat keeps a single owner (bootstrapped by `/seed/admin`). BetterAuth's
 * `update-member-role` never demotes the existing owner when you promote
 * someone else, so a true hand-off is: promote the new owner FIRST (so the org
 * is never left without an owner — which BetterAuth would reject), THEN demote
 * the previous owner to admin. This pure helper validates the request and
 * returns the ordered steps so the ordering is unit-testable in isolation.
 *
 * @throws if there is no current owner, or the chosen member is already the owner.
 */
export function planOwnershipTransfer(
	members: Pick<OrganizationMember, 'id' | 'userId' | 'role'>[],
	currentUserId: string | null | undefined,
	newOwnerMemberId: string
): Array<{ memberId: string; role: OrganizationRole }> {
	const currentOwner = currentUserId
		? members.find((m) => m.userId === currentUserId && m.role === 'owner')
		: undefined;
	if (!currentOwner) {
		throw new Error('Only the current owner can transfer ownership');
	}
	if (currentOwner.id === newOwnerMemberId) {
		throw new Error('You are already the owner');
	}

	return [
		{ memberId: newOwnerMemberId, role: 'owner' },
		{ memberId: currentOwner.id, role: 'admin' },
	];
}

// BetterAuth uses 'member' internally, but we use 'editor' in our app
type BetterAuthRole = 'owner' | 'admin' | 'member';

/**
 * Map BetterAuth role to our app role
 * BetterAuth uses 'member', we use 'editor'
 */
function mapFromBetterAuthRole(role: string): OrganizationRole {
	if (role === 'member') return 'editor';
	return role as OrganizationRole;
}

/**
 * Map our app role to BetterAuth role
 * We use 'editor', BetterAuth expects 'member'
 */
function mapToBetterAuthRole(role: OrganizationRole): BetterAuthRole {
	if (role === 'editor') return 'member';
	return role as BetterAuthRole;
}

export interface OrganizationMember {
	id: string;
	userId: string;
	organizationId: string;
	role: OrganizationRole;
	createdAt: Date;
	user: {
		id: string;
		name: string;
		email: string;
		image?: string | null;
	};
}

export interface OrganizationInvitation {
	id: string;
	email: string;
	role: OrganizationRole;
	status: 'pending' | 'accepted' | 'rejected' | 'canceled';
	expiresAt: Date;
	inviterId: string;
	organizationId: string;
}

export interface Organization {
	id: string;
	name: string;
	slug: string;
	logo?: string | null;
	metadata?: Record<string, unknown>;
	createdAt: Date;
}

// Module-level inflight tracking for fetch deduplication
let inflightFetch: Promise<void> | null = null;
let inflightOrgId: string | null = null;

// Time-based members cache to reduce redundant auth requests
let lastMembersFetchAt = 0;
let lastMembersFetchOrgId: string | null = null;
const MEMBERS_CACHE_TTL_MS = 60_000; // 60 seconds

// Module-level flag — resets on HMR (unlike useState which persists)
let watchSetUp = false;
const ORGANIZATION_SYNC_TIMEOUT_MS = 5_000;

/**
 * Composable for managing BetterAuth organization membership.
 * Uses shared state (useState) so all callers share the same data and
 * only one set of HTTP requests is made per organization switch.
 */
export function useOrganization() {
	// BetterAuth hooks — called fresh each time; they return the same internal
	// reactive state so multiple calls are cheap. Caching at module level broke
	// reactivity across HMR and could prevent isPending from resolving.
	const activeOrgRef = useActiveOrganization();
	const orgsListRef = useListOrganizations();

	// Shared reactive state via useState — all instances share the same refs
	const members = useState<OrganizationMember[]>('org-members', () => []);
	const invitations = useState<OrganizationInvitation[]>('org-invitations', () => []);
	const isLoadingMembers = useState<boolean>('org-loading-members', () => false);
	const currentMemberRole = useState<OrganizationRole | null>('org-current-role', () => null);

	// Computed values - BetterAuth hooks return refs with nested data/isPending
	const organization = computed(() => {
		const orgData = activeOrgRef.value;
		return orgData?.data ?? null;
	});

	const organizationId = computed(() => organization.value?.id ?? null);

	const isLoading = computed(() => {
		// Only track our own loading state (members/invitations fetch).
		// Don't rely on BetterAuth's isPending — it can get stuck when the
		// nanostores atom's shallowRef doesn't trigger after SSR hydration.
		// The session-level authPending in useOrganizationContext already gates
		// the initial loading state.
		return isLoadingMembers.value;
	});

	const organizationsList = computed(() => {
		const orgsData = orgsListRef.value;
		return orgsData?.data ?? [];
	});

	// Permission checks
	const canManageMembers = computed(() => {
		return currentMemberRole.value === 'owner' || currentMemberRole.value === 'admin';
	});

	const isOwner = computed(() => currentMemberRole.value === 'owner');

	async function waitForActiveOrganization(
		orgId: string,
		timeoutMs = ORGANIZATION_SYNC_TIMEOUT_MS
	) {
		if (organizationId.value === orgId) {
			return;
		}

		await new Promise<void>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				stop();
				reject(new Error('Timed out waiting for active organization to update'));
			}, timeoutMs);

			const stop = watch(
				organizationId,
				(currentOrganizationId) => {
					if (currentOrganizationId === orgId) {
						clearTimeout(timeoutId);
						stop();
						resolve();
					}
				},
				{ immediate: true }
			);
		});
	}

	/**
	 * Fetch organization members and invitations.
	 * Deduplicates concurrent requests for the same org.
	 */
	async function fetchMembers(options?: { force?: boolean }) {
		const orgId = organizationId.value;
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

					// Find current user's role
					const { user } = useAuth();
					if (user.value?.id) {
						const currentMember = members.value.find((m) => m.userId === user.value?.id);
						currentMemberRole.value = currentMember?.role ?? null;
					}
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
			} catch {
				// Fetch failed silently - members will remain empty
			} finally {
				isLoadingMembers.value = false;
				inflightFetch = null;
				inflightOrgId = null;
			}
		};

		inflightOrgId = orgId;
		inflightFetch = doFetch();
		return inflightFetch;
	}

	// Convex mutations for mailbox reservation tied to invitations.
	const { run: setPendingMailbox } = useBackendOperation(api.mail.pendingMailbox.setForInvitation, {
		label: 'Reserve invitation mailbox',
	});
	const { run: cancelPendingMailbox } = useBackendOperation(
		api.mail.pendingMailbox.cancelForInvitation,
		{
			label: 'Cancel reserved mailbox',
		}
	);
	// Read-only pre-check for the 1/min resend floor (the floor itself is enforced
	// server-side in the send hook). `run` toasts the rate-limit message and
	// returns undefined when the cooldown hasn't elapsed, so `resendInvite` can
	// bail out before hitting BetterAuth's resend.
	const { run: throttleResend } = useBackendOperation(api.auth.invitationResend.throttleResend, {
		label: 'Resend invitation',
	});

	/**
	 * Invite a new member to the organization. When `mailbox` is supplied,
	 * also reserve a pending mailbox at `localpart@domain` that will be
	 * auto-provisioned when the invitee accepts.
	 */
	async function invite(email: string, role: OrganizationRole, mailbox?: PendingMailboxInput) {
		if (!organizationId.value) {
			throw new Error('No active organization');
		}

		// Map our role to BetterAuth role (editor -> member)
		const result = await inviteOrgMember({
			organizationId: organizationId.value,
			email,
			role: mapToBetterAuthRole(role),
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to send invitation');
		}

		const invitationId: string | null =
			(result.data as { id?: string } | null | undefined)?.id ?? null;

		if (mailbox && invitationId) {
			// `run` toasts the categorized mailbox failure itself; we still throw a
			// flagged error so the invite caller knows the invite *was* sent.
			const reserved = await setPendingMailbox({
				invitationId,
				inviteeEmail: email,
				localpart: mailbox.localpart,
				domain: mailbox.domain,
				displayName: mailbox.displayName,
			});
			if (reserved === undefined) {
				const wrapped = new Error(
					'Invite sent, but: the mailbox could not be reserved for this invitation'
				);
				(wrapped as Error & { invitationSent?: boolean }).invitationSent = true;
				throw wrapped;
			}
		}

		// Refresh members list
		await fetchMembers({ force: true });

		return { invitationId };
	}

	/**
	 * Remove a member from the organization
	 */
	async function remove(memberIdOrEmail: string) {
		if (!organizationId.value) {
			throw new Error('No active organization');
		}

		const result = await removeOrgMember({
			organizationId: organizationId.value,
			memberIdOrEmail,
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to remove member');
		}

		// Refresh members list
		await fetchMembers({ force: true });

		return result.data;
	}

	/**
	 * Update a member's role
	 */
	async function updateRole(memberId: string, role: OrganizationRole) {
		if (!organizationId.value) {
			throw new Error('No active organization');
		}

		// Map our role to BetterAuth role (editor -> member)
		const result = await updateOrgMemberRole({
			organizationId: organizationId.value,
			memberId,
			role: mapToBetterAuthRole(role),
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to update role');
		}

		// Refresh members list
		await fetchMembers({ force: true });

		return result.data;
	}

	/**
	 * Transfer ownership of the organization to another member.
	 *
	 * Owlat is single-organization, single-owner (the owner is bootstrapped once
	 * by `/seed/admin`). BetterAuth's `update-member-role` does not demote the
	 * existing owner when you promote someone else, so a true hand-off is a
	 * two-step sequence: promote the new owner FIRST (the org briefly has two
	 * owners, which also satisfies BetterAuth's "can't leave the org without an
	 * owner" guard), THEN demote the previous owner to admin. Both steps go
	 * through the same `update-member-role` endpoint the role dropdown already
	 * uses — no new backend surface is required.
	 */
	async function transferOwnership(newOwnerMemberId: string) {
		if (!organizationId.value) {
			throw new Error('No active organization');
		}

		const { user } = useAuth();
		const steps = planOwnershipTransfer(members.value, user.value?.id, newOwnerMemberId);

		// Step 1 promotes the new owner; step 2 demotes the previous owner. The
		// order matters — by promoting first the org always has at least one
		// owner, so BetterAuth permits the subsequent demotion.
		let lastData: unknown = null;
		for (const step of steps) {
			const result = await updateOrgMemberRole({
				organizationId: organizationId.value,
				memberId: step.memberId,
				role: mapToBetterAuthRole(step.role),
			});
			if (result.error) {
				throw new Error(result.error.message || 'Failed to transfer ownership');
			}
			lastData = result.data;
		}

		await fetchMembers({ force: true });

		return lastData;
	}

	/**
	 * Cancel a pending invitation. Also clears any reserved mailbox
	 * attached to it (best-effort).
	 */
	async function cancelInvite(invitationId: string) {
		if (!organizationId.value) {
			throw new Error('No active organization');
		}

		const result = await cancelOrgInvitation({
			invitationId,
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to cancel invitation');
		}

		// Best-effort cleanup; a stale pending row is harmless until claim. `run`
		// swallows the throw (returning undefined), so the cancellation proceeds
		// regardless of whether the reserved mailbox could be cleared.
		await cancelPendingMailbox({ invitationId });

		// Refresh members list
		await fetchMembers({ force: true });

		return result.data;
	}

	/**
	 * Re-send the invitation email for a still-pending invite. The actual send
	 * goes through BetterAuth's `inviteMember({ resend: true })`, which reuses the
	 * existing pending invitation and re-triggers the system-mail path — so no new
	 * invite (or accept link) is created. The 1-per-minute floor is enforced
	 * server-side inside the send hook; `throttleResend` is a read-only pre-check
	 * so we can toast the friendly wait message and skip the round-trip when the
	 * cooldown hasn't elapsed, returning `false` without sending.
	 *
	 * @returns `true` when the email was re-sent, `false` when it was throttled.
	 */
	async function resendInvite(
		invitation: Pick<OrganizationInvitation, 'id' | 'email' | 'role'>
	): Promise<boolean> {
		if (!organizationId.value) {
			throw new Error('No active organization');
		}

		const allowed = await throttleResend({ invitationId: invitation.id });
		if (allowed === undefined) {
			// Throttled (or the throttle mutation failed) — `run` already toasted.
			return false;
		}

		const result = await inviteOrgMember({
			organizationId: organizationId.value,
			email: invitation.email,
			role: mapToBetterAuthRole(invitation.role),
			resend: true,
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to resend invitation');
		}

		return true;
	}

	/**
	 * Set the active organization
	 */
	async function setActive(orgId: string) {
		const result = await setActiveOrganization({
			organizationId: orgId,
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to set active organization');
		}

		const { refetch } = useAuth();
		await refetch({
			force: true,
			expected: 'authenticated',
			activeOrganizationId: orgId,
		});
		await waitForActiveOrganization(orgId);
		await fetchMembers({ force: true });

		return result.data;
	}

	/**
	 * Update the organization name or slug
	 */
	async function update(data: { name?: string; slug?: string; logo?: string }) {
		if (!organizationId.value) {
			throw new Error('No active organization');
		}

		const result = await updateOrg({
			organizationId: organizationId.value,
			data,
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to update organization');
		}

		return result.data;
	}

	/**
	 * Get full organization details including members
	 */
	async function getFullOrganization() {
		if (!organizationId.value) {
			throw new Error('No active organization');
		}

		const result = await getFullOrg({
			query: {
				organizationId: organizationId.value,
			},
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to get organization');
		}

		return result.data;
	}

	// Single watch — only the first instance sets it up to avoid duplicate fetchMembers.
	// Uses module-level flag (not useState) so it resets on HMR, allowing the watch to be re-created.
	if (!watchSetUp) {
		watchSetUp = true;
		watch(
			organizationId,
			async (newId) => {
				if (newId) {
					try {
						await fetchMembers();
					} catch {
						// Fetch failed silently
					}
				} else {
					members.value = [];
					invitations.value = [];
					currentMemberRole.value = null;
				}
			},
			{ immediate: true }
		);
	}

	return {
		// State
		organization,
		organizationId,
		organizations: organizationsList,
		members,
		invitations,
		currentMemberRole,
		isLoading,
		isLoadingMembers,

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
