<script setup lang="ts">
import { api } from '@owlat/api';
import type {
	OrganizationRole,
	OrganizationMember,
	OrganizationInvitation,
} from '~/composables/useOrganization';
import { ROLE_DEFINITIONS, roleDefinition } from '~/utils/teamRoles';
import { formatShortDate } from '~/utils/formatters';

useHead({ title: 'Team Management — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
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

// Copyable accept links for the pending-invites list. Every invitation exposes
// an accept URL of the form SITE_URL/invite/accept?id=<id>; this is the path
// that works even when outbound email delivery isn't configured yet.
const { copy } = useCopyToClipboard();
const requestUrl = useRequestURL();
function buildAcceptUrl(invitationId: string): string {
	return `${requestUrl.origin}/invite/accept?id=${encodeURIComponent(invitationId)}`;
}

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
const { canDeleteOrganization } = usePermissions();
const { signOut } = useAuth();
const showDeleteOrgModal = ref(false);
const deleteOrgConfirmText = ref('');
const isDeletingOrg = ref(false);
const { run: removeOrganization } = useBackendOperation(api.workspaces.settings.remove, {
	label: 'Delete workspace',
});

// Toast notification using global composable
const { showToast } = useToast();

// Handle cancel invite
const handleCancelInvite = async () => {
	if (!inviteToCancel.value) return;

	isCancelling.value = true;

	try {
		await cancelInvite(inviteToCancel.value.id, inviteToCancel.value.email);

		showToast('Invitation cancelled');
		inviteToCancel.value = null;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Failed to cancel invitation';
		showToast(errorMessage, 'error');
	} finally {
		isCancelling.value = false;
	}
};

// Copy an invite's accept link to the clipboard.
async function copyLinkText(url: string) {
	const ok = await copy(url);
	showToast(ok ? 'Invite link copied' : 'Could not copy the link', ok ? 'success' : 'error');
}
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
					? `Invitation re-sent to ${inv.email}`
					: `Email delivery isn't set up — copy the accept link for ${inv.email} instead.`
			);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : 'Failed to resend invitation';
		showToast(msg, 'error');
	} finally {
		resendingId.value = null;
	}
}

// Handle role change
const handleRoleChange = async (memberId: string, newRole: OrganizationRole) => {
	try {
		await updateRole(memberId, newRole);

		showToast('Role updated successfully');
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Failed to update role';
		showToast(errorMessage, 'error');
	}
};

// Handle remove member
const handleRemoveMember = async () => {
	if (!memberToRemove.value) return;

	isRemoving.value = true;

	try {
		await remove(memberToRemove.value.id);

		showToast('Team member removed');
		memberToRemove.value = null;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Failed to remove member';
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

		showToast('Ownership transferred successfully');
		memberToPromote.value = null;
		transferConfirmText.value = '';
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Failed to transfer ownership';
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
	if (result === undefined) {
		isDeletingOrg.value = false;
		return;
	}

	showToast('Workspace deletion started');
	showDeleteOrgModal.value = false;
	deleteOrgConfirmText.value = '';

	try {
		await signOut();
	} catch {
		isDeletingOrg.value = false;
	}
};

// Format relative time for invite expiry
const formatExpiryTime = (expiresAt: Date) => {
	const now = Date.now();
	const diff = new Date(expiresAt).getTime() - now;

	if (diff < 0) return 'Expired';

	const days = Math.floor(diff / (1000 * 60 * 60 * 24));
	const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

	if (days > 0) return `Expires in ${days}d ${hours}h`;
	if (hours > 0) return `Expires in ${hours}h`;
	return 'Expires soon';
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/settings"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Settings
			</NuxtLink>
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Team Members</h1>
					<p class="mt-1 text-text-secondary">Manage who has access to your team</p>
				</div>
				<UiButton v-if="canManageMembers" @click="inviteModal?.open()">
					<template #iconLeft>
						<Icon name="lucide:user-plus" class="w-4 h-4" />
					</template>
					Invite Member
				</UiButton>
			</div>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading && members.length === 0" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading team members…</p>
			</div>
		</div>

		<!-- Error State — the members fetch failed and we have nothing to show -->
		<UiCard v-else-if="membersError && members.length === 0" padding="none" overflow="hidden">
			<UiEmptyState
				icon="lucide:alert-circle"
				title="Couldn't load your team"
				:description="membersError"
			>
				<template #action>
					<UiButton :loading="isLoadingMembers" @click="fetchMembers({ force: true })">
						<template #iconLeft>
							<Icon v-if="!isLoadingMembers" name="lucide:refresh-cw" class="w-4 h-4" />
						</template>
						Try again
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
					<span>This list may be out of date — {{ membersError }}.</span>
				</p>
				<UiButton
					variant="ghost"
					size="sm"
					:loading="isLoadingMembers"
					@click="fetchMembers({ force: true })"
				>
					Retry
				</UiButton>
			</div>

			<!-- Team Members Section -->
			<UiCard padding="none">
				<template #header>
					<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
						<div class="flex items-center gap-3">
							<UiIconBox icon="lucide:users" size="sm" variant="surface" rounded="lg" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">Members</h2>
								<p class="text-sm text-text-secondary">
									{{ members.length }} team member{{ members.length !== 1 ? 's' : '' }}
								</p>
							</div>
						</div>
						<!-- Search box above the table -->
						<div class="sm:w-64">
							<label for="team-member-search" class="sr-only"
								>Search members by name or email</label
							>
							<UiInput
								id="team-member-search"
								v-model="memberSearch"
								type="text"
								size="sm"
								placeholder="Search name or email"
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
					title="No matches"
					:description="`No members match “${memberSearch.trim()}”.`"
				>
					<template #action>
						<UiButton variant="secondary" size="sm" @click="memberSearch = ''">
							Clear search
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Empty: nobody on the roster yet (no search term) -->
				<UiEmptyState
					v-else-if="filteredMembers.length === 0"
					icon="lucide:users"
					title="No team members yet"
					description="Invite teammates to collaborate on campaigns and shared inboxes."
				>
					<template v-if="canManageMembers" #action>
						<UiButton size="sm" @click="inviteModal?.open()">Invite a teammate</UiButton>
					</template>
				</UiEmptyState>

				<!-- Members table -->
				<div v-else class="overflow-x-auto">
					<table class="w-full min-w-[36rem] text-sm">
						<thead>
							<tr
								class="border-b border-border-subtle text-left text-xs font-medium text-text-tertiary"
							>
								<th scope="col" class="px-6 py-3 font-medium">Member</th>
								<th scope="col" class="px-4 py-3 font-medium">Role</th>
								<th scope="col" class="px-4 py-3 font-medium">Mailbox</th>
								<th scope="col" class="px-4 py-3 font-medium">Joined</th>
								<th scope="col" class="px-6 py-3">
									<span class="sr-only">Actions</span>
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
												{{ member.user.name || 'No name' }}
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
										{{ roleDefinition(member.role).label }}
									</span>
								</td>

								<!-- Mailbox: hosted / external / none -->
								<td class="px-4 py-4">
									<span
										v-if="isMailboxStatusPending"
										class="inline-flex items-center gap-1.5 text-sm text-text-tertiary"
										title="Checking mailbox status…"
									>
										<Icon
											name="lucide:loader-circle"
											class="w-3.5 h-3.5 animate-spin motion-reduce:animate-none"
										/>
										<span class="sr-only">Loading mailbox status</span>
										<span aria-hidden="true">—</span>
									</span>
									<span
										v-else
										class="inline-flex items-center gap-1.5 text-sm"
										:class="mailboxMetaFor(member.userId).toneClass"
										:title="mailboxMetaFor(member.userId).description"
									>
										<Icon :name="mailboxMetaFor(member.userId).icon" class="w-3.5 h-3.5" />
										{{ mailboxMetaFor(member.userId).label }}
									</span>
								</td>

								<!-- Joined date -->
								<td class="px-4 py-4 text-text-secondary whitespace-nowrap">
									{{ formatShortDate(member.createdAt) }}
								</td>

								<!-- Overflow menu: destructive + ownership actions -->
								<td class="px-6 py-4 text-right">
									<UiDropdownMenu
										v-if="isOwner && member.role !== 'owner'"
										v-model:open="dropdownOpenStates[member.id]"
									>
										<template #trigger>
											<UiButton
												variant="ghost"
												size="sm"
												:aria-label="`Actions for ${member.user.name || member.user.email}`"
											>
												<Icon name="lucide:more-horizontal" class="w-4 h-4" />
											</UiButton>
										</template>
										<UiDropdownMenuItem icon="lucide:crown" @click="memberToPromote = member">
											Transfer ownership
										</UiDropdownMenuItem>
										<UiDropdownDivider />
										<UiDropdownMenuItem
											icon="lucide:trash-2"
											danger
											@click="openRemoveMemberModal(member)"
										>
											Remove from team
										</UiDropdownMenuItem>
									</UiDropdownMenu>

									<!-- Admins (non-owners) may remove editors -->
									<UiButton
										v-else-if="canManageMembers && member.role === 'editor'"
										variant="ghost"
										size="sm"
										class="text-error"
										:aria-label="`Remove ${member.user.name || member.user.email}`"
										@click="memberToRemove = member"
									>
										<Icon name="lucide:trash-2" class="w-4 h-4" />
									</UiButton>
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
							<h2 class="text-lg font-semibold text-text-primary">Pending Invites</h2>
							<p class="text-sm text-text-secondary">
								{{ invitations.length }} pending invitation{{ invitations.length !== 1 ? 's' : '' }}
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
										{{ roleDefinition(invite.role).label }}
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
								title="Copy invite link"
								@click="copyInviteLink(invite.id)"
							>
								<Icon name="lucide:link" class="w-4 h-4 text-text-secondary" />
							</UiButton>
							<UiButton
								variant="ghost"
								size="sm"
								title="Resend invitation email"
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
								title="Revoke invitation"
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
				<h3 class="text-sm font-medium text-text-primary mb-4">What each role can do</h3>
				<div class="grid gap-4 sm:grid-cols-3">
					<div v-for="def in ROLE_DEFINITIONS" :key="def.role" class="flex items-start gap-3">
						<UiIconBox
							:icon="def.icon"
							size="sm"
							:variant="def.role === 'editor' ? 'surface' : 'brand'"
							rounded="lg"
						/>
						<div>
							<p class="font-medium text-text-primary text-sm">{{ def.label }}</p>
							<p class="text-xs text-text-secondary mt-0.5">{{ def.summary }}</p>
							<p class="text-xs text-text-tertiary mt-0.5">{{ def.detail }}</p>
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
							<h2 class="text-lg font-semibold text-error">Delete Workspace</h2>
							<p class="text-sm text-error/80">
								Permanently delete this workspace and all of its data
							</p>
						</div>
					</div>
				</template>

				<div class="p-6">
					<p class="text-text-secondary text-sm mb-4">
						Deleting the workspace permanently removes every team member, all contacts, campaigns,
						automations, mailboxes, and analytics. This action cannot be undone.
					</p>
					<UiButton variant="danger" @click="showDeleteOrgModal = true">
						<template #iconLeft>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</template>
						Delete Workspace
					</UiButton>
				</div>
			</UiCard>
		</div>

		<!-- Invite Member Modal (self-contained; opened via ref from the gated buttons) -->
		<SettingsTeamInviteModal ref="inviteModal" />

		<!-- Remove Member Confirmation Modal -->
		<UiModal
			:open="!!memberToRemove"
			title="Remove Team Member"
			@update:open="(v: boolean) => !v && (memberToRemove = null)"
		>
			<p class="text-text-secondary">
				Are you sure you want to remove
				<span v-if="memberToRemove" class="font-medium text-text-primary">
					{{ memberToRemove.user.name || memberToRemove.user.email }}
				</span>
				from this team? They will lose access to all team resources.
			</p>

			<template #footer>
				<UiButton variant="secondary" :disabled="isRemoving" @click="memberToRemove = null">
					Cancel
				</UiButton>
				<UiButton variant="danger" :loading="isRemoving" @click="handleRemoveMember">
					<template #iconLeft>
						<Icon v-if="!isRemoving" name="lucide:trash-2" class="w-4 h-4" />
					</template>
					{{ isRemoving ? 'Removing...' : 'Remove Member' }}
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
					<h2 class="text-lg font-semibold text-text-primary">Transfer Ownership</h2>
					<p class="text-sm text-text-secondary">Hand off the owner role</p>
				</div>
			</div>

			<div class="p-4 rounded-xl bg-bg-surface border border-border-subtle mb-6">
				<p class="text-sm text-text-secondary">
					<span v-if="memberToPromote" class="font-medium text-text-primary">{{
						memberToPromote.user.name || memberToPromote.user.email
					}}</span>
					will become the new <strong class="text-text-primary">Owner</strong> with full control of
					this workspace, including billing, settings, and the ability to delete it. You will be
					demoted to <strong>Admin</strong>. This cannot be undone by you — only the new owner can
					transfer it back.
				</p>
			</div>

			<div>
				<label class="label" for="confirm-transfer-ownership">
					Type <strong class="text-text-primary">TRANSFER</strong> to confirm
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
					Cancel
				</UiButton>
				<UiButton
					:loading="isTransferring"
					:disabled="transferConfirmText !== 'TRANSFER'"
					@click="handleTransferOwnership"
				>
					<template #iconLeft>
						<Icon v-if="!isTransferring" name="lucide:crown" class="w-4 h-4" />
					</template>
					{{ isTransferring ? 'Transferring...' : 'Transfer Ownership' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Cancel Invite Confirmation Modal -->
		<UiModal
			:open="!!inviteToCancel"
			title="Cancel Invitation"
			@update:open="(v: boolean) => !v && (inviteToCancel = null)"
		>
			<p class="text-text-secondary">
				Are you sure you want to cancel the invitation to
				<span v-if="inviteToCancel" class="font-medium text-text-primary">{{
					inviteToCancel.email
				}}</span
				>? They will not be able to join the team with this invite link.
			</p>

			<template #footer>
				<UiButton variant="secondary" :disabled="isCancelling" @click="inviteToCancel = null">
					Keep Invite
				</UiButton>
				<UiButton variant="danger" :loading="isCancelling" @click="handleCancelInvite">
					<template #iconLeft>
						<Icon v-if="!isCancelling" name="lucide:x" class="w-4 h-4" />
					</template>
					{{ isCancelling ? 'Cancelling...' : 'Cancel Invitation' }}
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
					<h2 class="text-lg font-semibold text-text-primary">Delete Workspace</h2>
					<p class="text-sm text-text-secondary">This cannot be undone</p>
				</div>
			</div>

			<div class="p-4 rounded-xl bg-error/5 border border-error/20 mb-6">
				<p class="text-sm text-error">
					<strong>Warning:</strong> This permanently deletes
					<span v-if="organization" class="font-medium">{{ organization.name }}</span>
					and all of its data — team members, contacts, campaigns, automations, mailboxes, and
					analytics. You will be signed out immediately.
				</p>
			</div>

			<div>
				<label class="label" for="confirm-delete-org">
					Type <strong class="text-error">DELETE</strong> to confirm
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
					Cancel
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
					{{ isDeletingOrg ? 'Deleting...' : 'Delete Workspace' }}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
