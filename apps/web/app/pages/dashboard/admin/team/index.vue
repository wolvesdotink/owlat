<script setup lang="ts">
import { api } from '@owlat/api';
import type {
	OrganizationRole,
	OrganizationMember,
	OrganizationInvitation,
} from '~/composables/useOrganization';
import SettingsTeamMembersCard from '~/components/settings/team/MembersCard.vue';
import SettingsTeamPendingInvitesCard from '~/components/settings/team/PendingInvitesCard.vue';
import SettingsTeamRolesCard from '~/components/settings/team/RolesCard.vue';
import {
	CircleWarningIcon,
	ReloadIcon,
	TriangleWarningIcon,
	UserPlusCornerIcon,
} from '@coolicons/vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.team.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

// Use BetterAuth organization management
const {
	members,
	invitations,
	isLoading,
	isLoadingMembers,
	membersError,
	canManageMembers,
	isOwner,
	fetchMembers,
	remove,
	updateRole,
	transferOwnership,
	cancelInvite,
	resendInvite,
} = useOrganization();
// Nothing loads the roster at boot any more; this page asks for it (the
// invite modal reads the same invitations). Started in setup so the spinner
// shows from the first frame instead of an empty roster.
void fetchMembers();

// Roster search + per-member mailbox status (hosted / external / none).
const { memberSearch, filteredMembers, isMailboxStatusPending, mailboxMetaFor } =
	useTeamMembers(members);

// Invite modal (self-contained: form, mailbox reservation, success accept link).
// Opened via its exposed open() from the permission-gated "Invite" affordances.
const inviteModal = ref<{ open: () => void } | null>(null);

// Copyable accept links for the pending-invites list. Shared with the invite
// modal so the two build and copy identical links.
const { buildAcceptUrl, copyLinkText } = useInviteLinks();

// Whether an outbound transport is actually configured. The resend API call
// succeeds even when it isn't (the send hook fails closed and BetterAuth
// swallows the error), so we only claim "we emailed them" when a transport
// exists — otherwise the accept link is the real (and only) way in.
const { data: emailConfigured } = useConvexQuery(
	api.workspaces.featureFlags.deliveryConfigured,
	() => ({})
);

// Remove member modal state
const memberToRemove = ref<OrganizationMember | null>(null);
const isRemoving = ref(false);

// Transfer ownership modal state (owner-only). Promotes the chosen member to
// owner and demotes the current owner to admin — the only succession path.
// The modal arms its confirm only once TRANSFER has been typed.
const memberToPromote = ref<OrganizationMember | null>(null);
const isTransferring = ref(false);

// Cancel invite modal state
const inviteToCancel = ref<OrganizationInvitation | null>(null);
const isCancelling = ref(false);

// Email-verification recovery (H3 escape hatch). When REQUIRE_EMAIL_VERIFICATION
// is on, an account that never received its verification link (mail outage, wrong
// provider, an account that predates the gate) cannot sign in. These two
// owner/admin-gated backend paths unblock them: mark the member verified
// out-of-band, or re-send the verification email through the same BetterAuth route
// a signup uses. Both are org-scoped and fail closed server-side.
const { run: markEmailVerified } = useBackendOperation(
	api.auth.emailVerificationAdmin.markMemberEmailVerified,
	{ label: () => t('dashboard.admin.team.operations.markEmailVerified') }
);
const { run: resendVerification } = useBackendOperation(
	api.auth.emailVerificationAdmin.resendMemberVerificationEmail,
	{ label: () => t('dashboard.admin.team.operations.resendVerification'), type: 'action' }
);

// Per-member inflight guards so a double-click can't fire the same recovery twice.
const verifyingMemberId = ref<string | null>(null);
const resendingVerifyId = ref<string | null>(null);

// Toast notification using global composable
const { showToast } = useToast();

// Handle cancel invite
const handleCancelInvite = async () => {
	if (!inviteToCancel.value) return;

	isCancelling.value = true;

	try {
		await cancelInvite(inviteToCancel.value.id, inviteToCancel.value.email);

		showToast(t('dashboard.admin.team.toasts.inviteCancelled'));
		inviteToCancel.value = null;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : t('dashboard.admin.team.toasts.cancelInviteFailed');
		showToast(errorMessage, 'error');
	} finally {
		isCancelling.value = false;
	}
};

function copyInviteLink(invitationId: string) {
	return copyLinkText(buildAcceptUrl(invitationId));
}

// Re-send the invitation email for a pending invite (server-side throttled to
// 1/min). resendInvite returns false — without throwing — when throttled, in
// which case the throttle message was already surfaced.
const resendingId = ref<string | null>(null);
async function handleResend(inv: OrganizationInvitation) {
	resendingId.value = inv.id;
	try {
		const sent = await resendInvite(inv);
		if (sent) {
			showToast(
				emailConfigured.value
					? t('dashboard.admin.team.toasts.inviteResent', { email: inv.email })
					: t('dashboard.admin.team.toasts.inviteResendNoTransport', { email: inv.email })
			);
		}
	} catch (error) {
		const msg =
			error instanceof Error ? error.message : t('dashboard.admin.team.toasts.resendInviteFailed');
		showToast(msg, 'error');
	} finally {
		resendingId.value = null;
	}
}

// Owner/admin escape hatch: mark a stranded member's email verified out-of-band
// so they can sign in again. Idempotent — an already-verified member is a no-op.
async function handleMarkVerified(member: OrganizationMember) {
	verifyingMemberId.value = member.id;
	try {
		const result = await markEmailVerified({ userId: member.userId });
		// `run` already surfaced any failure; only announce success.
		if (!result.ok) return;
		showToast(
			result.result.alreadyVerified
				? t('dashboard.admin.team.toasts.emailAlreadyVerified', { email: result.result.email })
				: t('dashboard.admin.team.toasts.emailVerified', { email: result.result.email })
		);
	} finally {
		verifyingMemberId.value = null;
	}
}

// Owner/admin escape hatch: re-send the verification link through BetterAuth's
// own sendVerificationEmail route. Only claim "we emailed them" when a transport
// exists — the send hook fails closed, so without one there is nothing to receive.
async function handleResendVerification(member: OrganizationMember) {
	resendingVerifyId.value = member.id;
	try {
		const result = await resendVerification({ userId: member.userId });
		if (!result.ok) return;
		if (!result.result.sent) {
			showToast(
				t('dashboard.admin.team.toasts.emailAlreadyVerified', { email: result.result.email })
			);
			return;
		}
		showToast(
			emailConfigured.value
				? t('dashboard.admin.team.toasts.verificationResent', { email: result.result.email })
				: t('dashboard.admin.team.toasts.verificationResendNoTransport', {
						email: result.result.email,
					})
		);
	} finally {
		resendingVerifyId.value = null;
	}
}

// Handle role change
const handleRoleChange = async (memberId: string, newRole: OrganizationRole) => {
	try {
		await updateRole(memberId, newRole);

		showToast(t('dashboard.admin.team.toasts.roleUpdated'));
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : t('dashboard.admin.team.toasts.updateRoleFailed');
		showToast(errorMessage, 'error');
	}
};

// Handle remove member
const handleRemoveMember = async () => {
	if (!memberToRemove.value) return;

	isRemoving.value = true;

	try {
		await remove(memberToRemove.value.id);

		showToast(t('dashboard.admin.team.toasts.memberRemoved'));
		memberToRemove.value = null;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : t('dashboard.admin.team.toasts.removeMemberFailed');
		showToast(errorMessage, 'error');
	} finally {
		isRemoving.value = false;
	}
};

// Open remove member modal
const openRemoveMemberModal = (member: OrganizationMember) => {
	memberToRemove.value = member;
};

// Handle transfer ownership — promotes the member to owner and demotes the
// current owner to admin. The modal only confirms once TRANSFER was typed.
const handleTransferOwnership = async () => {
	if (!memberToPromote.value) return;

	isTransferring.value = true;

	try {
		await transferOwnership(memberToPromote.value.id);

		showToast(t('dashboard.admin.team.toasts.ownershipTransferred'));
		memberToPromote.value = null;
	} catch (error) {
		const errorMessage =
			error instanceof Error
				? error.message
				: t('dashboard.admin.team.toasts.transferOwnershipFailed');
		showToast(errorMessage, 'error');
	} finally {
		isTransferring.value = false;
	}
};
</script>

<template>
	<!-- Members, invites and roles, nothing else: the pages that used to sit here
	     as link cards are in the Settings sidebar, and workspace-wide switches
	     (import on first login, deleting the workspace) live in Workspace → General. -->
	<div>
		<!-- The shared header stacks the invite button under the title on a phone
		     instead of squeezing the title beside it. -->
		<UiPageHeader
			class="mb-6"
			:title="t('dashboard.admin.team.title')"
			:description="t('dashboard.admin.team.lede')"
		>
			<template v-if="canManageMembers" #actions>
				<UiButton class="whitespace-nowrap" @click="inviteModal?.open()">
					<template #iconLeft>
						<UserPlusCornerIcon class="w-4 h-4" />
					</template>
					{{ t('dashboard.admin.team.inviteMember') }}
				</UiButton>
			</template>
		</UiPageHeader>
		<!-- Loading State -->
		<DashboardDetailSkeleton
			v-if="isLoading && members.length === 0"
			:label="t('dashboard.admin.team.loading')"
			:header="false"
			body="list"
			:sections="4"
		/>

		<!-- Error State — the members fetch failed and we have nothing to show -->
		<UiCard v-else-if="membersError && members.length === 0" padding="none" overflow="hidden">
			<UiEmptyState
				:icon="CircleWarningIcon"
				:title="t('dashboard.admin.team.loadError.title')"
				:description="membersError"
			>
				<template #action>
					<UiButton :loading="isLoadingMembers" @click="fetchMembers({ force: true })">
						<template #iconLeft>
							<ReloadIcon v-if="!isLoadingMembers" class="w-4 h-4" />
						</template>
						{{ t('dashboard.admin.team.loadError.tryAgain') }}
					</UiButton>
				</template>
			</UiEmptyState>
		</UiCard>

		<!-- Content -->
		<div v-else class="space-y-8">
			<!-- Non-blocking refresh error: we have a (possibly stale) roster, but the
			     latest refetch failed. Offer a retry without hiding the table. -->
			<div
				v-if="membersError"
				class="flex items-center justify-between gap-3 rounded-(--radius-card) border border-warning/20 bg-warning/5 px-4 py-3"
				role="alert"
			>
				<p class="flex items-center gap-2 text-sm text-text-secondary">
					<TriangleWarningIcon class="w-4 h-4 shrink-0 text-warning" />
					<span>{{ t('dashboard.admin.team.staleList', { error: membersError }) }}</span>
				</p>
				<UiButton
					variant="ghost"
					size="sm"
					:loading="isLoadingMembers"
					@click="fetchMembers({ force: true })"
				>
					{{ t('common.retry') }}
				</UiButton>
			</div>

			<!-- Team Members Section -->
			<SettingsTeamMembersCard
				v-model:member-search="memberSearch"
				:member-count="members.length"
				:filtered-members="filteredMembers"
				:can-manage-members="canManageMembers"
				:is-owner="isOwner"
				:is-mailbox-status-pending="isMailboxStatusPending"
				:mailbox-meta-for="mailboxMetaFor"
				:verifying-member-id="verifyingMemberId"
				:resending-verify-id="resendingVerifyId"
				@invite="inviteModal?.open()"
				@role-change="handleRoleChange"
				@mark-verified="handleMarkVerified"
				@resend-verification="handleResendVerification"
				@transfer="(member) => (memberToPromote = member)"
				@remove="openRemoveMemberModal"
			/>

			<!-- Pending Invites Section -->
			<SettingsTeamPendingInvitesCard
				v-if="invitations.length > 0"
				:invitations="invitations"
				:can-manage-members="canManageMembers"
				:resending-id="resendingId"
				@copy-link="copyInviteLink"
				@resend="handleResend"
				@revoke="(invite) => (inviteToCancel = invite)"
			/>

			<SettingsTeamRolesCard />
		</div>

		<!-- Invite Member Modal (self-contained; opened via ref from the gated buttons) -->
		<SettingsTeamInviteModal ref="inviteModal" />

		<SettingsTeamRemoveMemberModal
			:member="memberToRemove"
			:busy="isRemoving"
			@close="memberToRemove = null"
			@confirm="handleRemoveMember"
		/>

		<SettingsTeamTransferOwnershipModal
			:member="memberToPromote"
			:busy="isTransferring"
			@close="memberToPromote = null"
			@confirm="handleTransferOwnership"
		/>

		<SettingsTeamCancelInviteModal
			:invitation="inviteToCancel"
			:busy="isCancelling"
			@close="inviteToCancel = null"
			@confirm="handleCancelInvite"
		/>
	</div>
</template>
