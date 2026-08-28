<script setup lang="ts">
import { api } from '@owlat/api';
import type {
	OrganizationRole,
	OrganizationMember,
	OrganizationInvitation,
} from '~/composables/useOrganization';
import { ROLE_DEFINITIONS, roleDefinition } from '~/utils/teamRoles';
import { formatShortDate } from '~/utils/formatters';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.admin.team.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
});

// Use BetterAuth organization management
const {
	organization,
	members,
	invitations,
	currentMemberRole,
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

// Owner/admin may change instance settings (settings:manage). Mirrors the
// backend gate on the migration-mode toggle.
const canManageSettings = computed(() => isOwner.value || currentMemberRole.value === 'admin');

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

// Role change dropdown state (using reactive object for AppDropdownMenu v-model:open per member)
const dropdownOpenStates = reactive<Record<string, boolean>>({});

// Remove member modal state
const memberToRemove = ref<OrganizationMember | null>(null);
const isRemoving = ref(false);

// Transfer ownership modal state (owner-only). Promotes the chosen member to
// owner and demotes the current owner to admin — the only succession path.
const memberToPromote = ref<OrganizationMember | null>(null);
const transferConfirmText = ref('');
const isTransferring = ref(false);

// Cancel invite modal state
const inviteToCancel = ref<OrganizationInvitation | null>(null);
const isCancelling = ref(false);

// Delete organization (owner-only Danger Zone)
const { canDeleteOrganization, isAdmin } = usePermissions();

// Connected apps (Tier-2 external integrations) bind to a bundled plugin, so the
// card shows whenever plugins are bundled. It must also stay reachable when a
// plugin is removed from the build but connected-app records remain, so admins
// can still revoke/delete them: query the (owner/admin-gated) list only in that
// empty-build case, and skip it for anyone who couldn't read it anyway.
const { data: connectedAppsForNav } = useConvexQuery(api.connectedApps.queries.listByTeam, () =>
	isAdmin.value && bundledPluginComposition.length === 0 ? {} : 'skip'
);
const hasConnectedApps = computed(() => (connectedAppsForNav.value?.length ?? 0) > 0);
const showConnectedApps = computed(
	() => bundledPluginComposition.length > 0 || hasConnectedApps.value
);
const { signOut } = useAuth();
const showDeleteOrgModal = ref(false);
const deleteOrgConfirmText = ref('');
const isDeletingOrg = ref(false);
const { run: removeOrganization } = useBackendOperation(api.workspaces.settings.remove, {
	label: () => t('dashboard.admin.team.operations.deleteWorkspace'),
});

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
// current owner to admin. Requires typing TRANSFER to confirm.
const handleTransferOwnership = async () => {
	if (!memberToPromote.value) return;
	if (transferConfirmText.value !== 'TRANSFER') return;

	isTransferring.value = true;

	try {
		await transferOwnership(memberToPromote.value.id);

		showToast(t('dashboard.admin.team.toasts.ownershipTransferred'));
		memberToPromote.value = null;
		transferConfirmText.value = '';
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

// Handle delete organization — schedules the backend deletion walker,
// then signs the owner out (the whole tenant is being wiped).
const handleDeleteOrganization = async () => {
	if (deleteOrgConfirmText.value !== 'DELETE') return;

	isDeletingOrg.value = true;

	const result = await removeOrganization({});
	if (!result.ok) {
		isDeletingOrg.value = false;
		return;
	}

	showToast(t('dashboard.admin.team.toasts.workspaceDeletionStarted'));
	showDeleteOrgModal.value = false;
	deleteOrgConfirmText.value = '';

	try {
		await signOut();
	} catch {
		isDeletingOrg.value = false;
	}
};

/**
 * `utils/teamRoles` is a module-scope definition set whose label/summary/detail
 * carry i18n keys rather than sentences (the registry convention); a plain string
 * is still accepted so a value with nothing to translate reads as itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

// Format relative time for invite expiry
const formatExpiryTime = (expiresAt: Date) => {
	const now = Date.now();
	const diff = new Date(expiresAt).getTime() - now;

	if (diff < 0) return t('dashboard.admin.team.invites.expired');

	const days = Math.floor(diff / (1000 * 60 * 60 * 24));
	const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

	if (days > 0) return t('dashboard.admin.team.invites.expiresInDaysHours', { days, hours });
	if (hours > 0) return t('dashboard.admin.team.invites.expiresInHours', { hours });
	return t('dashboard.admin.team.invites.expiresSoon');
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/admin"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				{{ t('dashboard.admin.team.backToAdministration') }}
			</NuxtLink>
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.admin.team.title') }}
					</h1>
					<p class="mt-1 text-text-secondary">{{ t('dashboard.admin.team.lede') }}</p>
				</div>
				<UiButton v-if="canManageMembers" @click="inviteModal?.open()">
					<template #iconLeft>
						<Icon name="lucide:user-plus" class="w-4 h-4" />
					</template>
					{{ t('dashboard.admin.team.inviteMember') }}
				</UiButton>
			</div>
		</div>
		<nav
			class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 mb-8"
			:aria-label="t('dashboard.admin.team.nav.label')"
		>
			<NuxtLink to="/dashboard/admin/team/inboxes" class="card !p-4 hover:bg-bg-surface">
				<Icon name="lucide:mails" class="w-5 h-5 text-brand" />
				<p class="mt-2 font-medium text-text-primary">
					{{ t('dashboard.admin.team.nav.inboxes.title') }}
				</p>
				<p class="text-xs text-text-secondary">
					{{ t('dashboard.admin.team.nav.inboxes.description') }}
				</p>
			</NuxtLink>
			<NuxtLink to="/dashboard/admin/team/senders" class="card !p-4 hover:bg-bg-surface">
				<Icon name="lucide:at-sign" class="w-5 h-5 text-brand" />
				<p class="mt-2 font-medium text-text-primary">
					{{ t('dashboard.admin.team.nav.senders.title') }}
				</p>
				<p class="text-xs text-text-secondary">
					{{ t('dashboard.admin.team.nav.senders.description') }}
				</p>
			</NuxtLink>
			<NuxtLink to="/dashboard/admin/team/api" class="card !p-4 hover:bg-bg-surface">
				<Icon name="lucide:key-round" class="w-5 h-5 text-brand" />
				<p class="mt-2 font-medium text-text-primary">
					{{ t('dashboard.admin.team.nav.apiKeys.title') }}
				</p>
				<p class="text-xs text-text-secondary">
					{{ t('dashboard.admin.team.nav.apiKeys.description') }}
				</p>
			</NuxtLink>
			<NuxtLink to="/dashboard/admin/team/audit" class="card !p-4 hover:bg-bg-surface">
				<Icon name="lucide:clipboard-list" class="w-5 h-5 text-brand" />
				<p class="mt-2 font-medium text-text-primary">
					{{ t('dashboard.admin.team.nav.audit.title') }}
				</p>
				<p class="text-xs text-text-secondary">
					{{ t('dashboard.admin.team.nav.audit.description') }}
				</p>
			</NuxtLink>
			<!-- Shown while plugins are bundled, and while records from a removed
			     plugin remain, so external access stays revocable. -->
			<NuxtLink
				v-if="showConnectedApps"
				to="/dashboard/admin/team/connected-apps"
				class="card !p-4 hover:bg-bg-surface"
			>
				<Icon name="lucide:plug" class="w-5 h-5 text-brand" />
				<p class="mt-2 font-medium text-text-primary">
					{{ t('dashboard.admin.team.nav.connectedApps.title') }}
				</p>
				<p class="text-xs text-text-secondary">
					{{ t('dashboard.admin.team.nav.connectedApps.description') }}
				</p>
			</NuxtLink>
		</nav>

		<!-- Loading State -->
		<div v-if="isLoading && members.length === 0" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">{{ t('dashboard.admin.team.loading') }}</p>
			</div>
		</div>

		<!-- Error State — the members fetch failed and we have nothing to show -->
		<UiCard v-else-if="membersError && members.length === 0" padding="none" overflow="hidden">
			<UiEmptyState
				icon="lucide:alert-circle"
				:title="t('dashboard.admin.team.loadError.title')"
				:description="membersError"
			>
				<template #action>
					<UiButton :loading="isLoadingMembers" @click="fetchMembers({ force: true })">
						<template #iconLeft>
							<Icon v-if="!isLoadingMembers" name="lucide:refresh-cw" class="w-4 h-4" />
						</template>
						{{ t('dashboard.admin.team.loadError.tryAgain') }}
					</UiButton>
				</template>
			</UiEmptyState>
		</UiCard>

		<!-- Content -->
		<div v-else class="space-y-8">
			<!-- Onboarding: migration mode (offer new users a mail import at first login) -->
			<SettingsMigrationModeCard :can-manage="canManageSettings" />

			<!-- Non-blocking refresh error: we have a (possibly stale) roster, but the
			     latest refetch failed. Offer a retry without hiding the table. -->
			<div
				v-if="membersError"
				class="flex items-center justify-between gap-3 rounded-(--radius-card) border border-warning/20 bg-warning/5 px-4 py-3"
				role="alert"
			>
				<p class="flex items-center gap-2 text-sm text-text-secondary">
					<Icon name="lucide:alert-triangle" class="w-4 h-4 shrink-0 text-warning" />
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
			<UiCard padding="none">
				<template #header>
					<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
						<div class="flex items-center gap-3">
							<UiIconBox icon="lucide:users" size="sm" variant="surface" rounded="lg" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.admin.team.members.title') }}
								</h2>
								<p class="text-sm text-text-secondary">
									{{
										t(
											'dashboard.admin.team.members.count',
											{ count: members.length },
											members.length
										)
									}}
								</p>
							</div>
						</div>
						<!-- Search box above the table -->
						<div class="sm:w-64">
							<label for="team-member-search" class="sr-only">{{
								t('dashboard.admin.team.members.searchLabel')
							}}</label>
							<UiInput
								id="team-member-search"
								v-model="memberSearch"
								type="text"
								size="sm"
								:placeholder="t('dashboard.admin.team.members.searchPlaceholder')"
							>
								<template #iconLeft>
									<Icon name="lucide:search" class="w-4 h-4 text-text-tertiary" />
								</template>
							</UiInput>
						</div>
					</div>
				</template>

				<!-- Empty: no members match the search -->
				<UiEmptyState
					v-if="filteredMembers.length === 0 && memberSearch.trim()"
					icon="lucide:search-x"
					:title="t('dashboard.admin.team.members.noMatchesTitle')"
					:description="
						t('dashboard.admin.team.members.noMatchesDescription', {
							query: memberSearch.trim(),
						})
					"
				>
					<template #action>
						<UiButton variant="secondary" size="sm" @click="memberSearch = ''">
							{{ t('dashboard.admin.team.members.clearSearch') }}
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Empty: nobody on the roster yet (no search term) -->
				<UiEmptyState
					v-else-if="filteredMembers.length === 0"
					icon="lucide:users"
					:title="t('dashboard.admin.team.members.emptyTitle')"
					:description="t('dashboard.admin.team.members.emptyDescription')"
				>
					<template v-if="canManageMembers" #action>
						<UiButton size="sm" @click="inviteModal?.open()">{{
							t('dashboard.admin.team.members.inviteTeammate')
						}}</UiButton>
					</template>
				</UiEmptyState>

				<!-- Members table -->
				<div v-else class="overflow-x-auto">
					<table class="w-full min-w-[36rem] text-sm">
						<thead>
							<tr
								class="border-b border-border-subtle text-left text-xs font-medium text-text-tertiary"
							>
								<th scope="col" class="px-6 py-3 font-medium">
									{{ t('dashboard.admin.team.members.columns.member') }}
								</th>
								<th scope="col" class="px-4 py-3 font-medium">
									{{ t('dashboard.admin.team.members.columns.role') }}
								</th>
								<th scope="col" class="px-4 py-3 font-medium">
									{{ t('dashboard.admin.team.members.columns.mailbox') }}
								</th>
								<th scope="col" class="px-4 py-3 font-medium">
									{{ t('dashboard.admin.team.members.columns.joined') }}
								</th>
								<th scope="col" class="px-6 py-3">
									<span class="sr-only">{{ t('common.actions') }}</span>
								</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-border-subtle">
							<tr v-for="member in filteredMembers" :key="member.id" class="align-middle">
								<!-- Member: avatar + name/email -->
								<td class="px-6 py-4">
									<div class="flex items-center gap-3">
										<div
											v-if="member.user.image"
											class="h-9 w-9 shrink-0 rounded-full bg-cover bg-center"
											:style="{ backgroundImage: `url(${member.user.image})` }"
										/>
										<div
											v-else
											class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-surface"
										>
											<span class="text-sm font-medium text-text-secondary">
												{{ (member.user.name || member.user.email).charAt(0).toUpperCase() }}
											</span>
										</div>
										<div class="min-w-0">
											<p class="truncate font-medium text-text-primary">
												{{ member.user.name || t('dashboard.admin.team.members.noName') }}
											</p>
											<p class="truncate text-sm text-text-secondary">{{ member.user.email }}</p>
										</div>
									</div>
								</td>

								<!-- Role: inline change menu (owner only, non-owner members) -->
								<td class="px-4 py-4">
									<SettingsTeamRoleMenu
										v-if="isOwner && member.role !== 'owner'"
										:role="member.role"
										:member-label="member.user.name || member.user.email"
										@change="(role) => handleRoleChange(member.id, role)"
									/>
									<span
										v-else
										class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
										:class="roleDefinition(member.role).badgeToneClass"
									>
										<Icon :name="roleDefinition(member.role).icon" class="w-3 h-3" />
										{{ localized(roleDefinition(member.role).label) }}
									</span>
								</td>

								<!-- Mailbox: hosted / external / none -->
								<td class="px-4 py-4">
									<span
										v-if="isMailboxStatusPending"
										class="inline-flex items-center gap-1.5 text-sm text-text-tertiary"
										:title="t('dashboard.admin.team.members.mailboxChecking')"
									>
										<Icon
											name="lucide:loader-circle"
											class="w-3.5 h-3.5 animate-spin motion-reduce:animate-none"
										/>
										<span class="sr-only">{{
											t('dashboard.admin.team.members.mailboxLoading')
										}}</span>
										<span aria-hidden="true">—</span>
									</span>
									<span
										v-else
										class="inline-flex items-center gap-1.5 text-sm"
										:class="mailboxMetaFor(member.userId).toneClass"
										:title="localized(mailboxMetaFor(member.userId).description)"
									>
										<Icon :name="mailboxMetaFor(member.userId).icon" class="w-3.5 h-3.5" />
										{{ localized(mailboxMetaFor(member.userId).label) }}
									</span>
								</td>

								<!-- Joined date -->
								<td class="px-4 py-4 text-text-secondary whitespace-nowrap">
									{{ formatShortDate(member.createdAt, locale) }}
								</td>

								<!-- Overflow menu: verification recovery + ownership/destructive
								     actions. Owners and admins both manage members, so the menu
								     opens for any non-owner row; the owner-only and admin-only
								     entries are gated inside. -->
								<td class="px-6 py-4 text-right">
									<UiDropdownMenu
										v-if="canManageMembers && member.role !== 'owner'"
										v-model:open="dropdownOpenStates[member.id]"
									>
										<template #trigger>
											<UiButton
												variant="ghost"
												size="sm"
												:aria-label="
													t('dashboard.admin.team.members.rowActions', {
														member: member.user.name || member.user.email,
													})
												"
											>
												<Icon name="lucide:more-horizontal" class="w-4 h-4" />
											</UiButton>
										</template>
										<!-- Email-verification recovery (owner + admin): unblock a
										     member the verification gate stranded. -->
										<UiDropdownMenuItem
											icon="lucide:mail-check"
											:disabled="verifyingMemberId === member.id"
											@click="handleMarkVerified(member)"
										>
											{{ t('dashboard.admin.team.members.markEmailVerified') }}
										</UiDropdownMenuItem>
										<UiDropdownMenuItem
											icon="lucide:send"
											:disabled="resendingVerifyId === member.id"
											@click="handleResendVerification(member)"
										>
											{{ t('dashboard.admin.team.members.resendVerification') }}
										</UiDropdownMenuItem>
										<!-- Owner-only: succession + removing any member. -->
										<template v-if="isOwner">
											<UiDropdownDivider />
											<UiDropdownMenuItem icon="lucide:crown" @click="memberToPromote = member">
												{{ t('dashboard.admin.team.members.transferOwnership') }}
											</UiDropdownMenuItem>
											<UiDropdownDivider />
											<UiDropdownMenuItem
												icon="lucide:trash-2"
												danger
												@click="openRemoveMemberModal(member)"
											>
												{{ t('dashboard.admin.team.members.removeFromTeam') }}
											</UiDropdownMenuItem>
										</template>
										<!-- Admins (non-owners) may remove editors. -->
										<template v-else-if="member.role === 'editor'">
											<UiDropdownDivider />
											<UiDropdownMenuItem
												icon="lucide:trash-2"
												danger
												@click="openRemoveMemberModal(member)"
											>
												{{ t('dashboard.admin.team.members.removeFromTeam') }}
											</UiDropdownMenuItem>
										</template>
									</UiDropdownMenu>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</UiCard>

			<!-- Pending Invites Section -->
			<UiCard v-if="invitations.length > 0" padding="none" overflow="hidden">
				<template #header>
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.admin.team.invites.title') }}
							</h2>
							<p class="text-sm text-text-secondary">
								{{
									t(
										'dashboard.admin.team.invites.count',
										{ count: invitations.length },
										invitations.length
									)
								}}
							</p>
						</div>
					</div>
				</template>

				<div class="divide-y divide-border-subtle">
					<div
						v-for="invite in invitations"
						:key="invite.id"
						class="px-6 py-4 flex items-center justify-between"
					>
						<div class="flex items-center gap-4">
							<!-- Email Icon -->
							<div class="w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center">
								<Icon name="lucide:mail" class="w-5 h-5 text-text-tertiary" />
							</div>

							<!-- Email and Status -->
							<div>
								<div class="flex items-center gap-2">
									<p class="font-medium text-text-primary">{{ invite.email }}</p>
									<!-- Role Badge -->
									<span
										:class="[
											'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
											roleDefinition(invite.role).badgeToneClass,
										]"
									>
										<Icon :name="roleDefinition(invite.role).icon" class="w-3 h-3" />
										{{ localized(roleDefinition(invite.role).label) }}
									</span>
								</div>
								<div class="flex items-center gap-2 text-sm text-text-tertiary">
									<Icon name="lucide:clock" class="w-3 h-3" />
									<span>{{ formatExpiryTime(invite.expiresAt) }}</span>
								</div>
							</div>
						</div>

						<!-- Row actions: copy link / resend / revoke -->
						<div v-if="canManageMembers" class="flex items-center gap-1">
							<UiButton
								variant="ghost"
								size="sm"
								:title="t('dashboard.admin.team.invites.copyLink')"
								@click="copyInviteLink(invite.id)"
							>
								<Icon name="lucide:link" class="w-4 h-4 text-text-secondary" />
							</UiButton>
							<UiButton
								variant="ghost"
								size="sm"
								:title="t('dashboard.admin.team.invites.resend')"
								:loading="resendingId === invite.id"
								:disabled="resendingId === invite.id"
								@click="handleResend(invite)"
							>
								<Icon
									v-if="resendingId !== invite.id"
									name="lucide:send"
									class="w-4 h-4 text-text-secondary"
								/>
							</UiButton>
							<UiButton
								variant="ghost"
								size="sm"
								:title="t('dashboard.admin.team.invites.revoke')"
								@click="inviteToCancel = invite"
							>
								<Icon name="lucide:x" class="w-4 h-4 text-text-secondary hover:text-error" />
							</UiButton>
						</div>
					</div>
				</div>
			</UiCard>

			<!-- Role Permissions Info — single source of truth (ROLE_DEFINITIONS), the
			     same copy surfaced in the inline role menu. -->
			<UiCard>
				<h3 class="text-sm font-medium text-text-primary mb-4">
					{{ t('dashboard.admin.team.roles.title') }}
				</h3>
				<div class="grid gap-4 sm:grid-cols-3">
					<div v-for="def in ROLE_DEFINITIONS" :key="def.role" class="flex items-start gap-3">
						<UiIconBox
							:icon="def.icon"
							size="sm"
							:variant="def.role === 'editor' ? 'surface' : 'brand'"
							rounded="lg"
						/>
						<div>
							<p class="font-medium text-text-primary text-sm">{{ localized(def.label) }}</p>
							<p class="text-xs text-text-secondary mt-0.5">{{ localized(def.summary) }}</p>
							<p class="text-xs text-text-tertiary mt-0.5">{{ localized(def.detail) }}</p>
						</div>
					</div>
				</div>
			</UiCard>

			<!-- Danger Zone — Delete Organization (owner only) -->
			<UiCard v-if="canDeleteOrganization" padding="none" overflow="hidden" class="border-error/20">
				<template #header>
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:trash-2" size="sm" variant="error" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-error">
								{{ t('dashboard.admin.team.dangerZone.title') }}
							</h2>
							<p class="text-sm text-error/80">
								{{ t('dashboard.admin.team.dangerZone.subtitle') }}
							</p>
						</div>
					</div>
				</template>

				<div class="p-6">
					<p class="text-text-secondary text-sm mb-4">
						{{ t('dashboard.admin.team.dangerZone.body') }}
					</p>
					<UiButton variant="danger" @click="showDeleteOrgModal = true">
						<template #iconLeft>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</template>
						{{ t('dashboard.admin.team.dangerZone.title') }}
					</UiButton>
				</div>
			</UiCard>
		</div>

		<!-- Invite Member Modal (self-contained; opened via ref from the gated buttons) -->
		<SettingsTeamInviteModal ref="inviteModal" />

		<!-- Remove Member Confirmation Modal -->
		<UiModal
			:open="!!memberToRemove"
			:title="t('dashboard.admin.team.removeModal.title')"
			@update:open="(v: boolean) => !v && (memberToRemove = null)"
		>
			<I18nT
				keypath="dashboard.admin.team.removeModal.body"
				tag="p"
				class="text-text-secondary"
				scope="global"
			>
				<template #member>
					<span v-if="memberToRemove" class="font-medium text-text-primary">
						{{ memberToRemove.user.name || memberToRemove.user.email }}
					</span>
				</template>
			</I18nT>

			<template #footer>
				<UiButton variant="secondary" :disabled="isRemoving" @click="memberToRemove = null">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton variant="danger" :loading="isRemoving" @click="handleRemoveMember">
					<template #iconLeft>
						<Icon v-if="!isRemoving" name="lucide:trash-2" class="w-4 h-4" />
					</template>
					{{
						isRemoving
							? t('dashboard.admin.team.removeModal.removing')
							: t('dashboard.admin.team.removeModal.confirm')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Transfer Ownership Confirmation Modal (owner only) -->
		<UiModal
			:open="!!memberToPromote"
			size="lg"
			:closable="!isTransferring"
			:persistent="isTransferring"
			@update:open="
				(v: boolean) => {
					if (!v) {
						memberToPromote = null;
						transferConfirmText = '';
					}
				}
			"
		>
			<div class="flex items-center gap-3 mb-6">
				<UiIconBox icon="lucide:crown" size="sm" variant="brand" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('dashboard.admin.team.transferModal.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.admin.team.transferModal.subtitle') }}
					</p>
				</div>
			</div>

			<div class="p-4 rounded-xl bg-bg-surface border border-border-subtle mb-6">
				<I18nT
					keypath="dashboard.admin.team.transferModal.body"
					tag="p"
					class="text-sm text-text-secondary"
					scope="global"
				>
					<template #member>
						<span v-if="memberToPromote" class="font-medium text-text-primary">{{
							memberToPromote.user.name || memberToPromote.user.email
						}}</span>
					</template>
					<template #ownerRole>
						<strong class="text-text-primary">{{
							t('dashboard.admin.team.transferModal.ownerRole')
						}}</strong>
					</template>
					<template #adminRole>
						<strong>{{ t('dashboard.admin.team.transferModal.adminRole') }}</strong>
					</template>
				</I18nT>
			</div>

			<div>
				<label class="label" for="confirm-transfer-ownership">
					<I18nT keypath="dashboard.admin.team.transferModal.typeToConfirm" scope="global">
						<template #phrase><strong class="text-text-primary">TRANSFER</strong></template>
					</I18nT>
				</label>
				<input
					id="confirm-transfer-ownership"
					v-model="transferConfirmText"
					type="text"
					class="input"
					placeholder="TRANSFER"
					autocomplete="off"
					:disabled="isTransferring"
				/>
			</div>

			<template #footer>
				<UiButton
					variant="secondary"
					:disabled="isTransferring"
					@click="
						memberToPromote = null;
						transferConfirmText = '';
					"
				>
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					:loading="isTransferring"
					:disabled="transferConfirmText !== 'TRANSFER'"
					@click="handleTransferOwnership"
				>
					<template #iconLeft>
						<Icon v-if="!isTransferring" name="lucide:crown" class="w-4 h-4" />
					</template>
					{{
						isTransferring
							? t('dashboard.admin.team.transferModal.transferring')
							: t('dashboard.admin.team.transferModal.confirm')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Cancel Invite Confirmation Modal -->
		<UiModal
			:open="!!inviteToCancel"
			:title="t('dashboard.admin.team.cancelInviteModal.title')"
			@update:open="(v: boolean) => !v && (inviteToCancel = null)"
		>
			<I18nT
				keypath="dashboard.admin.team.cancelInviteModal.body"
				tag="p"
				class="text-text-secondary"
				scope="global"
			>
				<template #email>
					<span v-if="inviteToCancel" class="font-medium text-text-primary">{{
						inviteToCancel.email
					}}</span>
				</template>
			</I18nT>

			<template #footer>
				<UiButton variant="secondary" :disabled="isCancelling" @click="inviteToCancel = null">
					{{ t('dashboard.admin.team.cancelInviteModal.keep') }}
				</UiButton>
				<UiButton variant="danger" :loading="isCancelling" @click="handleCancelInvite">
					<template #iconLeft>
						<Icon v-if="!isCancelling" name="lucide:x" class="w-4 h-4" />
					</template>
					{{
						isCancelling
							? t('dashboard.admin.team.cancelInviteModal.cancelling')
							: t('dashboard.admin.team.cancelInviteModal.confirm')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Organization Confirmation Modal (owner only) -->
		<UiModal
			:open="showDeleteOrgModal"
			size="lg"
			:closable="!isDeletingOrg"
			:persistent="isDeletingOrg"
			@update:open="
				(v: boolean) => {
					if (!v) {
						showDeleteOrgModal = false;
						deleteOrgConfirmText = '';
					}
				}
			"
		>
			<div class="flex items-center gap-3 mb-6">
				<UiIconBox icon="lucide:alert-triangle" size="sm" variant="error" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('dashboard.admin.team.deleteModal.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.admin.team.deleteModal.subtitle') }}
					</p>
				</div>
			</div>

			<div class="p-4 rounded-xl bg-error/5 border border-error/20 mb-6">
				<I18nT
					keypath="dashboard.admin.team.deleteModal.warning"
					tag="p"
					class="text-sm text-error"
					scope="global"
				>
					<template #label>
						<strong>{{ t('dashboard.admin.team.deleteModal.warningLabel') }}</strong>
					</template>
					<template #workspace>
						<span v-if="organization" class="font-medium">{{ organization.name }}</span>
					</template>
				</I18nT>
			</div>

			<div>
				<label class="label" for="confirm-delete-org">
					<I18nT keypath="dashboard.admin.team.deleteModal.typeToConfirm" scope="global">
						<template #phrase><strong class="text-error">DELETE</strong></template>
					</I18nT>
				</label>
				<input
					id="confirm-delete-org"
					v-model="deleteOrgConfirmText"
					type="text"
					class="input"
					placeholder="DELETE"
					autocomplete="off"
					:disabled="isDeletingOrg"
				/>
			</div>

			<template #footer>
				<UiButton
					variant="secondary"
					:disabled="isDeletingOrg"
					@click="
						showDeleteOrgModal = false;
						deleteOrgConfirmText = '';
					"
				>
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					variant="danger"
					:loading="isDeletingOrg"
					:disabled="deleteOrgConfirmText !== 'DELETE'"
					@click="handleDeleteOrganization"
				>
					<template #iconLeft>
						<Icon v-if="!isDeletingOrg" name="lucide:trash-2" class="w-4 h-4" />
					</template>
					{{
						isDeletingOrg
							? t('dashboard.admin.team.deleteModal.deleting')
							: t('dashboard.admin.team.deleteModal.confirm')
					}}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
