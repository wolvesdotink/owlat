/**
 * The organization roster's shapes (members, invitations, the organization) and
 * the role vocabulary BetterAuth speaks, shared by `useOrganization` and the
 * member and invitation actions it is built from.
 */
import type { OrganizationRole } from '@owlat/shared/organizationPermissions';

export interface PendingMailboxInput {
	localpart: string;
	domain: string;
	displayName?: string;
}

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
 * Module scope, so it carries i18n KEYS rather than sentences (the registry
 * convention); `transferOwnership` resolves them with `t()` before they reach a
 * toast.
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
		throw new Error('shared.useOrganization.errors.notCurrentOwner');
	}
	if (currentOwner.id === newOwnerMemberId) {
		throw new Error('shared.useOrganization.errors.alreadyOwner');
	}

	return [
		{ memberId: newOwnerMemberId, role: 'owner' },
		{ memberId: currentOwner.id, role: 'admin' },
	];
}

// BetterAuth uses 'member' internally, but we use 'editor' in our app
type BetterAuthRole = 'owner' | 'admin' | 'member';

/**
 * Map our app role to BetterAuth role
 * We use 'editor', BetterAuth expects 'member'
 */
export function mapToBetterAuthRole(role: OrganizationRole): BetterAuthRole {
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
