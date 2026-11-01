/**
 * The roster writes on existing members: remove one, change a role, hand over
 * ownership. Each goes through BetterAuth and then reloads the lists.
 */
import type { Ref } from 'vue';
import type { OrganizationRole } from '@owlat/shared/organizationPermissions';
import {
	removeMember as removeOrgMember,
	updateMemberRole as updateOrgMemberRole,
} from '~/lib/auth-client';
import { mapToBetterAuthRole, planOwnershipTransfer, type OrganizationMember } from './roster';

export function useOrganizationMemberActions(options: {
	t: (key: string) => string;
	organizationId: Readonly<Ref<string | null>>;
	members: Ref<OrganizationMember[]>;
	sessionUserId: () => string | undefined;
	fetchMembers: (options?: { force?: boolean }) => Promise<void>;
}) {
	const { t, organizationId, members, sessionUserId, fetchMembers } = options;

	/**
	 * Remove a member from the organization
	 */
	async function remove(memberIdOrEmail: string) {
		if (!organizationId.value) {
			throw new Error(t('shared.useOrganization.errors.noActiveOrganization'));
		}

		const result = await removeOrgMember({
			organizationId: organizationId.value,
			memberIdOrEmail,
		});

		if (result.error) {
			throw new Error(
				result.error.message || t('shared.useOrganization.errors.removeMemberFailed')
			);
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
			throw new Error(t('shared.useOrganization.errors.noActiveOrganization'));
		}

		// Map our role to BetterAuth role (editor -> member)
		const result = await updateOrgMemberRole({
			organizationId: organizationId.value,
			memberId,
			role: mapToBetterAuthRole(role),
		});

		if (result.error) {
			throw new Error(result.error.message || t('shared.useOrganization.errors.updateRoleFailed'));
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
			throw new Error(t('shared.useOrganization.errors.noActiveOrganization'));
		}

		// `planOwnershipTransfer` is module scope, so it throws the message KEY;
		// resolve it here, where `t` exists, so the team page toasts the sentence
		// rather than a key path.
		let steps: Array<{ memberId: string; role: OrganizationRole }>;
		try {
			steps = planOwnershipTransfer(members.value, sessionUserId(), newOwnerMemberId);
		} catch (error) {
			if (error instanceof Error) throw new Error(t(error.message), { cause: error });
			throw error;
		}

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
				throw new Error(
					result.error.message || t('shared.useOrganization.errors.transferOwnershipFailed')
				);
			}
			lastData = result.data;
		}

		await fetchMembers({ force: true });

		return lastData;
	}

	return { remove, updateRole, transferOwnership };
}
