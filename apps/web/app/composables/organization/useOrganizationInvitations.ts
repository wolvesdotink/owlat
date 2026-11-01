/**
 * The roster writes on invitations: invite (optionally reserving the invitee's
 * mailbox), cancel, and resend. Each goes through BetterAuth; invite and cancel
 * then reload the lists.
 */
import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { OrganizationRole } from '@owlat/shared/organizationPermissions';
import {
	inviteMember as inviteOrgMember,
	cancelInvitation as cancelOrgInvitation,
} from '~/lib/auth-client';
import {
	mapToBetterAuthRole,
	type OrganizationInvitation,
	type PendingMailboxInput,
} from './roster';

export function useOrganizationInvitations(options: {
	t: (key: string) => string;
	organizationId: Readonly<Ref<string | null>>;
	fetchMembers: (options?: { force?: boolean }) => Promise<void>;
}) {
	const { t, organizationId, fetchMembers } = options;

	// Convex mutations for mailbox reservation tied to invitations.
	const { run: setPendingMailbox } = useBackendOperation(api.mail.pendingMailbox.setForInvitation, {
		label: () => t('shared.useOrganization.operations.reserveMailbox'),
	});
	const { run: cancelPendingMailbox } = useBackendOperation(
		api.mail.pendingMailbox.cancelForInvitation,
		{
			label: () => t('shared.useOrganization.operations.cancelReservedMailbox'),
		}
	);
	// Grants are keyed by invitee email (not invitation id), so cancelling an
	// invite must also sweep any pending team-inbox membership reserved for them —
	// otherwise the inbox would silently materialize if they ever joined later.
	const { run: cancelPendingInboxMemberships } = useBackendOperation(
		api.mail.pendingInboxMembership.cancelInboxMembershipsForEmail,
		{
			label: () => t('shared.useOrganization.operations.cancelReservedInboxAccess'),
		}
	);
	// Read-only pre-check for the 1/min resend floor (the floor itself is enforced
	// server-side in the send hook). `run` toasts the rate-limit message and
	// returns undefined when the cooldown hasn't elapsed, so `resendInvite` can
	// bail out before hitting BetterAuth's resend.
	const { run: throttleResend } = useBackendOperation(api.auth.invitationResend.throttleResend, {
		label: () => t('shared.useOrganization.operations.resendInvitation'),
	});

	/**
	 * Invite a new member to the organization. When `mailbox` is supplied,
	 * also reserve a pending mailbox at `localpart@domain` that will be
	 * auto-provisioned when the invitee accepts.
	 */
	async function invite(email: string, role: OrganizationRole, mailbox?: PendingMailboxInput) {
		if (!organizationId.value) {
			throw new Error(t('shared.useOrganization.errors.noActiveOrganization'));
		}

		// Map our role to BetterAuth role (editor -> member)
		const result = await inviteOrgMember({
			organizationId: organizationId.value,
			email,
			role: mapToBetterAuthRole(role),
		});

		if (result.error) {
			throw new Error(
				result.error.message || t('shared.useOrganization.errors.sendInvitationFailed')
			);
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
			if (!reserved.ok) {
				const wrapped = new Error(t('shared.useOrganization.errors.mailboxNotReserved'));
				(wrapped as Error & { invitationSent?: boolean }).invitationSent = true;
				throw wrapped;
			}
		}

		// Refresh members list
		await fetchMembers({ force: true });

		return { invitationId };
	}

	/**
	 * Cancel a pending invitation. Also clears any reserved mailbox attached to it
	 * and — when the invitee email is known — any pending team-inbox membership
	 * grant reserved for them (both best-effort).
	 */
	async function cancelInvite(invitationId: string, inviteeEmail?: string) {
		if (!organizationId.value) {
			throw new Error(t('shared.useOrganization.errors.noActiveOrganization'));
		}

		const result = await cancelOrgInvitation({
			invitationId,
		});

		if (result.error) {
			throw new Error(
				result.error.message || t('shared.useOrganization.errors.cancelInvitationFailed')
			);
		}

		// Best-effort cleanup; a stale pending row is harmless until claim. `run`
		// swallows the throw (returning undefined), so the cancellation proceeds
		// regardless of whether the reserved mailbox could be cleared.
		await cancelPendingMailbox({ invitationId });

		// Grants are bound to the email, so sweep them too when we have it. A
		// grant left behind would silently grant inbox access on a later join.
		if (inviteeEmail) {
			await cancelPendingInboxMemberships({ inviteeEmail });
		}

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
			throw new Error(t('shared.useOrganization.errors.noActiveOrganization'));
		}

		const allowed = await throttleResend({ invitationId: invitation.id });
		if (!allowed.ok) {
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
			throw new Error(
				result.error.message || t('shared.useOrganization.errors.resendInvitationFailed')
			);
		}

		return true;
	}

	return { invite, cancelInvite, resendInvite };
}
