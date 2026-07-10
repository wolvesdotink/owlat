<script setup lang="ts">
import { api } from '@owlat/api';
import type {
	OrganizationRole,
	OrganizationMember,
	OrganizationInvitation,
} from '~/composables/useOrganization';
import { isValidEmail } from '~/utils/validation';
import {
	ROLE_DEFINITIONS,
	roleDefinition,
	mailboxStatusMeta,
	type MailboxStatusMeta,
} from '~/utils/teamRoles';
import { formatShortDate } from '~/utils/formatters';

useHead({ title: 'Team Management — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Use BetterAuth organization management
const {
	organization,
	organizationId,
	members,
	invitations,
	currentMemberRole,
	isLoading,
	isLoadingMembers,
	membersError,
	canManageMembers,
	isOwner,
	fetchMembers,
	invite,
	remove,
	updateRole,
	transferOwnership,
	cancelInvite,
	resendInvite,
} = useOrganization();

// Owner/admin may change instance settings (settings:manage). Mirrors the
// backend gate on the migration-mode toggle.
const canManageSettings = computed(() => isOwner.value || currentMemberRole.value === 'admin');

// Roles an admin may invite into (never owner — ownership is transferred, not
// invited). Copy is the single ROLE_DEFINITIONS source so the invite modal and
// the role legend never diverge.
const inviteRoleOptions = ROLE_DEFINITIONS.filter((r) => r.role !== 'owner');

// Search box above the members table. Filters by name or email, case-insensitive.
const memberSearch = ref('');
const filteredMembers = computed(() => {
	const q = memberSearch.value.trim().toLowerCase();
	if (!q) return members.value;
	return members.value.filter(
		(m) => m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q)
	);
});

// Per-member mailbox status (hosted / external / none) for the Mailbox column.
// Keyed by BetterAuth user id; absent ⇒ no mailbox. Any org member may read it.
const memberUserIds = computed(() => members.value.map((m) => m.userId));
const { data: mailboxStatusData, isLoading: isLoadingMailboxStatus } = useConvexQuery(
	api.mail.memberMailboxStatus.byMembers,
	() => ({
		userIds: memberUserIds.value,
	})
);

// While the status query is still resolving we don't yet know if a member has a
// mailbox — render a neutral placeholder instead of a definitive "No mailbox".
const isMailboxStatusPending = computed(
	() => isLoadingMailboxStatus.value && mailboxStatusData.value === undefined
);

// Precompute the presentable Mailbox cell once per member so the four reads a
// row needs (tone/icon/label/description) don't each re-run the mapping.
const mailboxMetaByUserId = computed<Record<string, MailboxStatusMeta>>(() => {
	const map: Record<string, MailboxStatusMeta> = {};
	for (const member of members.value) {
		map[member.userId] = mailboxStatusMeta(mailboxStatusData.value?.[member.userId] ?? 'none');
	}
	return map;
});

function mailboxMetaFor(userId: string): MailboxStatusMeta {
	return mailboxMetaByUserId.value[userId] ?? mailboxStatusMeta('none');
}

// Copyable accept links. Every invitation exposes an accept URL of the form
// SITE_URL/invite/accept?id=<id>; this is the path that works even when
// outbound email delivery isn't configured yet.
const { copy } = useCopyToClipboard();
const requestUrl = useRequestURL();
function buildAcceptUrl(invitationId: string): string {
	return `${requestUrl.origin}/invite/accept?id=${encodeURIComponent(invitationId)}`;
}

// Postbox feature + verified domain lookup for the optional mailbox slot.
const { isEnabled } = useFeatureFlag();
const postboxEnabled = computed(() => isEnabled('postbox'));
const { data: domainsData } = useConvexQuery(api.domains.domains.listByOrganization, () => ({}));
const verifiedDomains = computed(() =>
	(domainsData.value ?? []).filter((d) => d.status === 'verified')
);
const canOfferMailbox = computed(() => postboxEnabled.value && verifiedDomains.value.length > 0);

// Whether an outbound transport is actually configured. The invite/resend API
// calls succeed even when it isn't (the send hook fails closed and BetterAuth
// swallows the error), so we only claim "we emailed them" when a transport
// exists — otherwise the accept link is the real (and only) way in.
const { data: emailConfigured } = useConvexQuery(
	api.organizations.featureFlags.deliveryConfigured,
	() => ({})
);

// Invite modal state (shared form-modal primitive for the open/close/form/
// submitting state). The two error slots stay in a dedicated reactive because
// `mailbox` is a cross-field error, not a form field.
const {
	isOpen: isInviteModalOpen,
	isSubmitting: isInviting,
	form: inviteForm,
	open: openInviteFormModal,
	reset: resetInviteFormState,
} = useFormModal({
	email: '',
	role: 'editor' as OrganizationRole,
	addMailbox: false,
	mailboxLocalpart: '',
	mailboxDomain: '',
	mailboxDisplayName: '',
});
const inviteFormErrors = reactive({
	email: '',
	mailbox: '',
});

// After a successful invite we keep the modal open on a success panel that
// surfaces the copyable accept link. Cleared when the modal closes and on
// "Invite another".
const inviteSuccess = ref<{
	email: string;
	acceptUrl: string;
	mailboxAddress?: string;
} | null>(null);

// Once the admin hand-edits the mailbox local part we stop auto-deriving it
// from the invitee's email address.
const localpartEdited = ref(false);

// True once the admin manually toggles the "Reserve a mailbox" checkbox. Until
// then the form is pristine, so the default-on watcher below may still apply the
// reserved-by-default rule when hosted mail resolves after the modal is open.
const mailboxTouched = ref(false);

// Pre-select the first verified domain when the user opts into the mailbox section.
watch(
	() => [inviteForm.addMailbox, verifiedDomains.value.length] as const,
	([addMailbox]) => {
		if (addMailbox && !inviteForm.mailboxDomain && verifiedDomains.value.length > 0) {
			inviteForm.mailboxDomain = verifiedDomains.value[0]!.domain;
		}
	}
);

const mailboxPreviewAddress = computed(() => {
	const lp = inviteForm.mailboxLocalpart.trim().toLowerCase();
	if (!lp || !inviteForm.mailboxDomain) return '';
	return `${lp}@${inviteForm.mailboxDomain}`;
});

// Suggest a mailbox local part from the invitee's email until the admin edits it.
function deriveLocalpart(email: string): string {
	const local = email.split('@')[0] ?? '';
	return local.toLowerCase().replace(/[^a-z0-9._-]/g, '');
}
watch(
	() => inviteForm.email,
	(email) => {
		if (!localpartEdited.value) {
			inviteForm.mailboxLocalpart = deriveLocalpart(email);
		}
	}
);

function resetInviteForm() {
	resetInviteFormState();
	inviteFormErrors.email = '';
	inviteFormErrors.mailbox = '';
	localpartEdited.value = false;
	mailboxTouched.value = false;
	inviteSuccess.value = null;
}

// Open the invite modal with a fresh form + cleared errors. A personal mailbox
// is reserved by default whenever hosted mail is configured (verified domain +
// Postbox); the admin can uncheck it.
function openInviteModal() {
	openInviteFormModal();
	resetInviteForm();
	inviteForm.addMailbox = canOfferMailbox.value;
}

// Reserved-by-default (locked decision #4): if the modal opens before the
// verified-domains query resolves, `canOfferMailbox` is briefly false and the
// checkbox snapshots unchecked. Re-apply the default the moment hosted mail
// becomes available — but only while the form is still pristine (modal open, not
// on the success panel, checkbox untouched) so we never override a deliberate
// uncheck.
watch(canOfferMailbox, (canOffer) => {
	if (canOffer && isInviteModalOpen.value && !inviteSuccess.value && !mailboxTouched.value) {
		inviteForm.addMailbox = true;
	}
});

// Reset the form whenever the modal is dismissed so the next open starts clean.
watch(isInviteModalOpen, (open) => {
	if (!open) resetInviteForm();
});

// "Invite another" from the success panel: clear the form but keep the modal
// open, re-applying the default mailbox reservation.
function startAnotherInvite() {
	resetInviteForm();
	inviteForm.addMailbox = canOfferMailbox.value;
}

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
const { run: removeOrganization } = useBackendOperation(api.organizations.settings.remove, {
	label: 'Delete organization',
});

// Toast notification using global composable
const { showToast } = useToast();

const localpartRegex = /^[a-z0-9._-]+$/i;

// Validate invite form
const validateInviteForm = (): boolean => {
	inviteFormErrors.email = '';
	inviteFormErrors.mailbox = '';

	if (!inviteForm.email.trim()) {
		inviteFormErrors.email = 'Email is required';
		return false;
	}

	if (!isValidEmail(inviteForm.email.trim())) {
		inviteFormErrors.email = 'Please enter a valid email address';
		return false;
	}

	// Warn before submit if this address already has a pending invite — resending
	// or copying the existing link is what the admin actually wants here.
	const emailNorm = inviteForm.email.trim().toLowerCase();
	if (invitations.value.some((inv) => inv.email.toLowerCase() === emailNorm)) {
		inviteFormErrors.email =
			'There is already a pending invite for this address. Resend or copy its link from the list below.';
		return false;
	}

	if (inviteForm.addMailbox) {
		const lp = inviteForm.mailboxLocalpart.trim();
		if (!lp) {
			inviteFormErrors.mailbox = 'Local part is required for the mailbox';
			return false;
		}
		if (!localpartRegex.test(lp)) {
			inviteFormErrors.mailbox = 'Use letters, digits, dots, hyphens, or underscores';
			return false;
		}
		if (!inviteForm.mailboxDomain) {
			inviteFormErrors.mailbox = 'Pick a verified domain';
			return false;
		}
	}

	return true;
};

// Handle invite submission
const handleInvite = async () => {
	if (!organizationId.value) return;
	if (!validateInviteForm()) return;

	isInviting.value = true;

	const mailbox = inviteForm.addMailbox
		? {
				localpart: inviteForm.mailboxLocalpart.trim().toLowerCase(),
				domain: inviteForm.mailboxDomain,
				displayName: inviteForm.mailboxDisplayName.trim() || undefined,
			}
		: undefined;

	try {
		const { invitationId } = await invite(inviteForm.email.trim(), inviteForm.role, mailbox);

		if (invitationId) {
			// Keep the modal open on the success panel so the admin can copy the
			// accept link — the always-works path when email delivery isn't set up.
			inviteSuccess.value = {
				email: inviteForm.email.trim(),
				acceptUrl: buildAcceptUrl(invitationId),
				mailboxAddress: mailbox ? `${mailbox.localpart}@${mailbox.domain}` : undefined,
			};
		} else {
			const successMsg = mailbox
				? `Invitation sent to ${inviteForm.email}. Mailbox ${mailbox.localpart}@${mailbox.domain} will be created when they accept.`
				: `Invitation sent to ${inviteForm.email}`;
			showToast(successMsg);
			isInviteModalOpen.value = false;
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Failed to send invitation';
		showToast(errorMessage, 'error');
	} finally {
		isInviting.value = false;
	}
};

// Handle cancel invite
const handleCancelInvite = async () => {
	if (!inviteToCancel.value) return;

	isCancelling.value = true;

	try {
		await cancelInvite(inviteToCancel.value.id);

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

	showToast('Organization deletion started');
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
				<UiButton v-if="canManageMembers" @click="openInviteModal()">
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
						<UiButton size="sm" @click="openInviteModal()">Invite a teammate</UiButton>
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
							<h2 class="text-lg font-semibold text-error">Delete Organization</h2>
							<p class="text-sm text-error/80">
								Permanently delete this organization and all of its data
							</p>
						</div>
					</div>
				</template>

				<div class="p-6">
					<p class="text-text-secondary text-sm mb-4">
						Deleting the organization permanently removes every team member, all contacts,
						campaigns, automations, mailboxes, and analytics. This action cannot be undone.
					</p>
					<UiButton variant="danger" @click="showDeleteOrgModal = true">
						<template #iconLeft>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</template>
						Delete Organization
					</UiButton>
				</div>
			</UiCard>
		</div>

		<!-- Invite Member Modal -->
		<UiModal v-model:open="isInviteModalOpen" title="Invite Team Member">
			<form v-if="!inviteSuccess" @submit.prevent="handleInvite">
				<div class="space-y-4">
					<!-- Email -->
					<UiInput
						v-model="inviteForm.email"
						type="email"
						label="Email Address"
						placeholder="colleague@company.com"
						:error="inviteFormErrors.email"
						:disabled="isInviting"
						:required="true"
					/>

					<!-- Role — copy comes from the single ROLE_DEFINITIONS source so it
					     stays honest to the permission map (owner is never invitable). -->
					<div>
						<label class="label">Role</label>
						<div class="grid grid-cols-2 gap-3">
							<button
								v-for="def in inviteRoleOptions"
								:key="def.role"
								type="button"
								:class="[
									'p-3 rounded-xl border text-left transition-all',
									inviteForm.role === def.role
										? 'border-brand bg-brand/10'
										: 'border-border-subtle hover:border-border-default',
								]"
								:disabled="isInviting"
								@click="inviteForm.role = def.role"
							>
								<div class="flex items-center gap-2 mb-1">
									<Icon :name="def.icon" class="w-4 h-4 text-text-secondary" />
									<span class="font-medium text-text-primary text-sm">{{ def.label }}</span>
								</div>
								<p class="text-xs text-text-secondary">{{ def.summary }}</p>
								<p class="mt-0.5 text-xs text-text-tertiary">{{ def.detail }}</p>
							</button>
						</div>
					</div>

					<!-- Reserve a personal mailbox (Postbox). On by default when hosted
					     mail is configured; shown disabled with an explanation when it
					     isn't, rather than hidden. -->
					<div class="space-y-3 pt-2 border-t border-border-subtle">
						<label
							class="flex items-start gap-2"
							:class="canOfferMailbox ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'"
						>
							<input
								v-model="inviteForm.addMailbox"
								type="checkbox"
								class="mt-0.5"
								:disabled="isInviting || !canOfferMailbox"
								@change="mailboxTouched = true"
							/>
							<span>
								<span class="font-medium text-text-primary text-sm">
									Reserve a personal mailbox for this user
								</span>
								<span v-if="canOfferMailbox" class="block text-xs text-text-secondary mt-0.5">
									We'll create the mailbox automatically when they accept. On by default — uncheck
									to invite without one.
								</span>
								<span v-else class="block text-xs text-text-secondary mt-0.5">
									Set up hosted mail — a verified sending domain and the Postbox — to reserve
									mailboxes for new members.
								</span>
							</span>
						</label>

						<div v-if="canOfferMailbox && inviteForm.addMailbox" class="space-y-3 pl-6">
							<div>
								<label class="text-sm font-medium block mb-1">Address</label>
								<div class="flex items-center gap-2">
									<input
										v-model="inviteForm.mailboxLocalpart"
										type="text"
										placeholder="marcel"
										class="input flex-1"
										:disabled="isInviting"
										pattern="[a-zA-Z0-9.\-_]+"
										@input="localpartEdited = true"
									/>
									<span class="text-text-tertiary">@</span>
									<select v-model="inviteForm.mailboxDomain" class="input" :disabled="isInviting">
										<option value="">Select domain</option>
										<option v-for="d in verifiedDomains" :key="d._id" :value="d.domain">
											{{ d.domain }}
										</option>
									</select>
								</div>
								<p v-if="mailboxPreviewAddress" class="text-xs text-text-tertiary mt-1">
									Will be created as: <code>{{ mailboxPreviewAddress }}</code>
								</p>
							</div>

							<div>
								<label for="inviteform-mailboxdisplayname" class="text-sm font-medium block mb-1">
									Display name (optional)
								</label>
								<input
									id="inviteform-mailboxdisplayname"
									v-model="inviteForm.mailboxDisplayName"
									type="text"
									placeholder="Marcel Pfeifer"
									class="input w-full"
									:disabled="isInviting"
								/>
							</div>

							<p v-if="inviteFormErrors.mailbox" class="text-sm text-error">
								{{ inviteFormErrors.mailbox }}
							</p>
						</div>
					</div>
				</div>
			</form>

			<!-- Success state: surface the copyable accept link. This link works even
			     when outbound email delivery isn't configured yet. -->
			<div v-else class="space-y-4">
				<div class="flex items-start gap-3">
					<UiIconBox icon="lucide:check" size="sm" variant="brand" rounded="lg" />
					<div>
						<p class="font-medium text-text-primary">Invitation ready</p>
						<p v-if="emailConfigured" class="text-sm text-text-secondary">
							We emailed {{ inviteSuccess?.email }} — you can also share the accept link directly.
						</p>
						<p v-else class="text-sm text-text-secondary">
							Share the accept link below with {{ inviteSuccess?.email }} — email delivery isn't set
							up yet, so this is how they get in.
						</p>
					</div>
				</div>

				<p v-if="inviteSuccess?.mailboxAddress" class="text-sm text-text-secondary">
					Mailbox <code>{{ inviteSuccess.mailboxAddress }}</code> will be created when they accept.
				</p>

				<div>
					<label class="text-sm font-medium block mb-1">Accept link</label>
					<div class="flex items-center gap-2">
						<input
							:value="inviteSuccess?.acceptUrl"
							readonly
							class="input flex-1 font-mono text-xs"
							@focus="($event.target as HTMLInputElement).select()"
						/>
						<UiButton variant="secondary" @click="copyLinkText(inviteSuccess?.acceptUrl ?? '')">
							<template #iconLeft>
								<Icon name="lucide:copy" class="w-4 h-4" />
							</template>
							Copy
						</UiButton>
					</div>
					<p class="text-xs text-text-tertiary mt-1">
						Works even if email delivery isn't set up yet.
					</p>
				</div>
			</div>

			<template #footer>
				<template v-if="inviteSuccess">
					<UiButton variant="secondary" @click="startAnotherInvite()">
						<template #iconLeft>
							<Icon name="lucide:user-plus" class="w-4 h-4" />
						</template>
						Invite another
					</UiButton>
					<UiButton @click="isInviteModalOpen = false">Done</UiButton>
				</template>
				<template v-else>
					<UiButton variant="secondary" :disabled="isInviting" @click="isInviteModalOpen = false">
						Cancel
					</UiButton>
					<UiButton :loading="isInviting" @click="handleInvite">
						<template #iconLeft>
							<Icon v-if="!isInviting" name="lucide:user-plus" class="w-4 h-4" />
						</template>
						{{ isInviting ? 'Sending...' : 'Send Invitation' }}
					</UiButton>
				</template>
			</template>
		</UiModal>

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
					this organization, including billing, settings, and the ability to delete it. You will be
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
					<h2 class="text-lg font-semibold text-text-primary">Delete Organization</h2>
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
					{{ isDeletingOrg ? 'Deleting...' : 'Delete Organization' }}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
