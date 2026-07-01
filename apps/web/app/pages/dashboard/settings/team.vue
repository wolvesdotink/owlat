<script setup lang="ts">
import { api } from '@owlat/api';
import type {
	OrganizationRole,
	OrganizationMember,
	OrganizationInvitation,
} from '~/composables/useOrganization';
import { isValidEmail } from '~/utils/validation';

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
	canManageMembers,
	isOwner,
	fetchMembers,
	invite,
	remove,
	updateRole,
	transferOwnership,
	cancelInvite,
} = useOrganization();

// Postbox feature + verified domain lookup for the optional mailbox slot.
const { isEnabled } = useFeatureFlag();
const postboxEnabled = computed(() => isEnabled('postbox'));
const { data: domainsData } = useConvexQuery(
	api.domains.domains.listByOrganization,
	() => ({}),
);
const verifiedDomains = computed(() =>
	(domainsData.value ?? []).filter((d) => d.status === 'verified'),
);
const canOfferMailbox = computed(
	() => postboxEnabled.value && verifiedDomains.value.length > 0,
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

// Pre-select the first verified domain when the user opts into the mailbox section.
watch(
	() => [inviteForm.addMailbox, verifiedDomains.value.length] as const,
	([addMailbox]) => {
		if (
			addMailbox &&
			!inviteForm.mailboxDomain &&
			verifiedDomains.value.length > 0
		) {
			inviteForm.mailboxDomain = verifiedDomains.value[0]!.domain;
		}
	},
);

const mailboxPreviewAddress = computed(() => {
	const lp = inviteForm.mailboxLocalpart.trim().toLowerCase();
	if (!lp || !inviteForm.mailboxDomain) return '';
	return `${lp}@${inviteForm.mailboxDomain}`;
});

function resetInviteForm() {
	resetInviteFormState();
	inviteFormErrors.email = '';
	inviteFormErrors.mailbox = '';
}

// Open the invite modal with a fresh form + cleared errors.
function openInviteModal() {
	openInviteFormModal();
	inviteFormErrors.email = '';
	inviteFormErrors.mailbox = '';
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

	if (inviteForm.addMailbox) {
		const lp = inviteForm.mailboxLocalpart.trim();
		if (!lp) {
			inviteFormErrors.mailbox = 'Local part is required for the mailbox';
			return false;
		}
		if (!localpartRegex.test(lp)) {
			inviteFormErrors.mailbox =
				'Use letters, digits, dots, hyphens, or underscores';
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
		await invite(inviteForm.email.trim(), inviteForm.role, mailbox);

		const successMsg = mailbox
			? `Invitation sent to ${inviteForm.email}. Mailbox ${mailbox.localpart}@${mailbox.domain} will be created when they accept.`
			: `Invitation sent to ${inviteForm.email}`;
		showToast(successMsg);
		isInviteModalOpen.value = false;
		resetInviteForm();
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
		const errorMessage =
			error instanceof Error ? error.message : 'Failed to transfer ownership';
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

// Get role icon component
const getRoleIcon = (role: string) => {
	switch (role) {
		case 'owner':
			return 'lucide:crown';
		case 'admin':
			return 'lucide:shield';
		default:
			return 'lucide:user';
	}
};

// Get role badge class
const getRoleBadgeClass = (role: string) => {
	switch (role) {
		case 'owner':
			return 'bg-brand/20 text-brand border-brand/30';
		case 'admin':
			return 'bg-brand/20 text-brand border-brand/30';
		default:
			return 'bg-bg-surface text-text-secondary border-border-subtle';
	}
};

// Get display role name
const getDisplayRoleName = (role: string) => {
	return role.charAt(0).toUpperCase() + role.slice(1);
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
				<p class="text-text-secondary text-sm">Loading team members...</p>
			</div>
		</div>

		<!-- Content -->
		<div v-else class="space-y-8">
			<!-- Team Members Section -->
			<UiCard padding="none" overflow="hidden">
				<template #header>
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:users" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-text-primary">Members</h2>
							<p class="text-sm text-text-secondary">
								{{ members.length }} team member{{ members.length !== 1 ? 's' : '' }}
							</p>
						</div>
					</div>
				</template>

				<div class="divide-y divide-border-subtle">
					<div
						v-for="member in members"
						:key="member.id"
						class="px-6 py-4 flex items-center justify-between"
					>
						<div class="flex items-center gap-4">
							<!-- Avatar -->
							<div class="relative">
								<div
									v-if="member.user.image"
									class="w-10 h-10 rounded-full bg-cover bg-center"
									:style="{ backgroundImage: `url(${member.user.image})` }"
								/>
								<div
									v-else
									class="w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center"
								>
									<span class="text-lg font-medium text-text-secondary">
										{{ (member.user.name || member.user.email).charAt(0).toUpperCase() }}
									</span>
								</div>
							</div>

							<!-- Name and Email -->
							<div>
								<div class="flex items-center gap-2">
									<p class="font-medium text-text-primary">
										{{ member.user.name || 'No name' }}
									</p>
									<!-- Role Badge -->
									<span
										:class="[
											'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
											getRoleBadgeClass(member.role),
										]"
									>
										<Icon :name="getRoleIcon(member.role)" class="w-3 h-3" />
										{{ getDisplayRoleName(member.role) }}
									</span>
								</div>
								<p class="text-sm text-text-secondary">{{ member.user.email }}</p>
							</div>
						</div>

						<!-- Actions -->
						<div class="flex items-center gap-2">
							<!-- Role change dropdown (only for non-owners, only visible to owner) -->
							<UiDropdownMenu
								v-if="isOwner && member.role !== 'owner'"
								v-model:open="dropdownOpenStates[member.id]"
							>
								<template #trigger>
									<UiButton variant="ghost" size="sm">
										<Icon name="lucide:more-horizontal" class="w-4 h-4" />
									</UiButton>
								</template>
								<UiDropdownMenuItem
									v-if="member.role !== 'admin'"
									icon="lucide:shield"
									@click="handleRoleChange(member.id, 'admin')"
								>
									Make Admin
								</UiDropdownMenuItem>
								<UiDropdownMenuItem
									v-if="member.role !== 'editor'"
									icon="lucide:user"
									@click="handleRoleChange(member.id, 'editor')"
								>
									Make Editor
								</UiDropdownMenuItem>
								<UiDropdownDivider />
								<UiDropdownMenuItem
									icon="lucide:crown"
									@click="memberToPromote = member"
								>
									Transfer ownership
								</UiDropdownMenuItem>
								<UiDropdownDivider />
								<UiDropdownMenuItem icon="lucide:trash-2" danger @click="openRemoveMemberModal(member)">
									Remove from team
								</UiDropdownMenuItem>
							</UiDropdownMenu>

							<!-- Remove button for admins (non-owners can remove editors) -->
							<button
								v-else-if="canManageMembers && member.role === 'editor'"
								class="btn btn-ghost p-2 text-error hover:bg-error/10"
								title="Remove member"
								@click="memberToRemove = member"
							>
								<Icon name="lucide:trash-2" class="w-4 h-4" />
							</button>
						</div>
					</div>
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
								{{ invitations.length }} pending invitation{{
									invitations.length !== 1 ? 's' : ''
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
											getRoleBadgeClass(invite.role),
										]"
									>
										<Icon :name="getRoleIcon(invite.role)" class="w-3 h-3" />
										{{ getDisplayRoleName(invite.role) }}
									</span>
								</div>
								<div class="flex items-center gap-2 text-sm text-text-tertiary">
									<Icon name="lucide:clock" class="w-3 h-3" />
									<span>{{ formatExpiryTime(invite.expiresAt) }}</span>
								</div>
							</div>
						</div>

						<!-- Cancel Button -->
						<UiButton
							v-if="canManageMembers"
							variant="ghost"
							size="sm"
							title="Cancel invitation"
							@click="inviteToCancel = invite"
						>
							<Icon name="lucide:x" class="w-4 h-4 text-text-secondary hover:text-error" />
						</UiButton>
					</div>
				</div>
			</UiCard>

			<!-- Role Permissions Info -->
			<UiCard>
				<h3 class="text-sm font-medium text-text-primary mb-4">Role Permissions</h3>
				<div class="grid gap-4 sm:grid-cols-3">
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:crown" size="sm" variant="brand" rounded="lg" />
						<div>
							<p class="font-medium text-text-primary text-sm">Owner</p>
							<p class="text-xs text-text-secondary mt-0.5">
								Full access. Can delete team, manage billing, settings, and all members.
							</p>
						</div>
					</div>
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:shield" size="sm" variant="brand" rounded="lg" />
						<div>
							<p class="font-medium text-text-primary text-sm">Admin</p>
							<p class="text-xs text-text-secondary mt-0.5">
								Can send campaigns, manage contacts, settings, and invite members.
							</p>
						</div>
					</div>
					<div class="flex items-start gap-3">
						<UiIconBox icon="lucide:user" size="sm" variant="surface" rounded="lg" />
						<div>
							<p class="font-medium text-text-primary text-sm">Editor</p>
							<p class="text-xs text-text-secondary mt-0.5">
								View-only access to campaigns, contacts, and analytics. Can send test emails and participate in chat.
							</p>
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
						Deleting the organization permanently removes every team member, all
						contacts, campaigns, automations, mailboxes, and analytics. This action
						cannot be undone.
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
			<form @submit.prevent="handleInvite">
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

					<!-- Role -->
					<div>
						<label class="label">Role</label>
						<div class="grid grid-cols-2 gap-3">
							<button
								type="button"
								:class="[
									'p-3 rounded-xl border text-left transition-all',
									inviteForm.role === 'editor'
										? 'border-brand bg-brand/10'
										: 'border-border-subtle hover:border-border-default',
								]"
								:disabled="isInviting"
								@click="inviteForm.role = 'editor'"
							>
								<div class="flex items-center gap-2 mb-1">
									<Icon name="lucide:user" class="w-4 h-4 text-text-secondary" />
									<span class="font-medium text-text-primary text-sm">Editor</span>
								</div>
								<p class="text-xs text-text-secondary">Create and edit emails, view contacts</p>
							</button>
							<button
								type="button"
								:class="[
									'p-3 rounded-xl border text-left transition-all',
									inviteForm.role === 'admin'
										? 'border-brand bg-brand/10'
										: 'border-border-subtle hover:border-border-default',
								]"
								:disabled="isInviting"
								@click="inviteForm.role = 'admin'"
							>
								<div class="flex items-center gap-2 mb-1">
									<Icon name="lucide:shield" class="w-4 h-4 text-brand" />
									<span class="font-medium text-text-primary text-sm">Admin</span>
								</div>
								<p class="text-xs text-text-secondary">Send campaigns, manage contacts and team</p>
							</button>
						</div>
					</div>

					<!-- Optional: reserve a personal mailbox (Postbox) -->
					<div v-if="canOfferMailbox" class="space-y-3 pt-2 border-t border-border-subtle">
						<label class="flex items-start gap-2 cursor-pointer">
							<input
								v-model="inviteForm.addMailbox"
								type="checkbox"
								class="mt-0.5"
								:disabled="isInviting"
							/>
							<span>
								<span class="font-medium text-text-primary text-sm">
									Also reserve a personal mailbox for this user
								</span>
								<span class="block text-xs text-text-secondary mt-0.5">
									We'll create the mailbox automatically when they accept.
								</span>
							</span>
						</label>

						<div v-if="inviteForm.addMailbox" class="space-y-3 pl-6">
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
									/>
									<span class="text-text-tertiary">@</span>
									<select
										v-model="inviteForm.mailboxDomain"
										class="input"
										:disabled="isInviting"
									>
										<option value="">Select domain</option>
										<option
											v-for="d in verifiedDomains"
											:key="d._id"
											:value="d.domain"
										>
											{{ d.domain }}
										</option>
									</select>
								</div>
								<p
									v-if="mailboxPreviewAddress"
									class="text-xs text-text-tertiary mt-1"
								>
									Will be created as: <code>{{ mailboxPreviewAddress }}</code>
								</p>
							</div>

							<div>
								<label for="inviteform-mailboxdisplayname" class="text-sm font-medium block mb-1">
									Display name (optional)
								</label>
								<input id="inviteform-mailboxdisplayname"
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

			<template #footer>
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
			@update:open="(v: boolean) => { if (!v) { memberToPromote = null; transferConfirmText = ''; } }"
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
					will become the new <strong class="text-text-primary">Owner</strong> with
					full control of this organization, including billing, settings, and the
					ability to delete it. You will be demoted to <strong>Admin</strong>. This
					cannot be undone by you — only the new owner can transfer it back.
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
					@click="memberToPromote = null; transferConfirmText = '';"
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
			@update:open="(v: boolean) => { if (!v) { showDeleteOrgModal = false; deleteOrgConfirmText = ''; } }"
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
					and all of its data — team members, contacts, campaigns, automations,
					mailboxes, and analytics. You will be signed out immediately.
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
					@click="showDeleteOrgModal = false; deleteOrgConfirmText = '';"
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
