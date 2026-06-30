<script setup lang="ts">
import { sanitizeCsvCell } from '@owlat/shared';
import { api } from '@owlat/api';
import Papa from 'papaparse';
import { isValidEmail } from '~/utils/validation';
import { authClient } from '~/lib/auth-client';

useHead({ title: 'Account Settings — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { hasActiveOrganization, role } = useOrganizationContext();
const { user } = useAuth();

// Account deletion erases different data depending on the member's role.
// Owners trigger the org-deletion walker (the whole tenant dataset goes), so
// their list covers org-owned contacts/campaigns/API keys/webhooks/analytics.
// Non-owner members are routed to the member-erasure job, which only removes
// their PERSONAL data — org-owned records belong to the org and survive — so
// promising every user the same org-wide deletion would be misleading.
const isOwner = computed(() => role.value === 'owner');

// Get user ID for account management (uses authUserId which is BetterAuth user ID)
const userId = computed(() => user.value?.id ?? null);
const convex = useConvex();
const { showToast } = useToast();

// ── Profile (display name) ──
const nameDraft = ref('');
watch(
	user,
	(u) => {
		if (u && !nameDraft.value) nameDraft.value = u.name ?? '';
	},
	{ immediate: true },
);
const savingProfile = ref(false);
async function saveProfile() {
	const name = nameDraft.value.trim();
	if (!name) return;
	savingProfile.value = true;
	try {
		const res = await authClient.updateUser({ name });
		if (res.error) showToast(res.error.message ?? 'Could not update profile', 'error');
		else showToast('Profile updated');
	} catch {
		showToast('Could not update profile', 'error');
	} finally {
		savingProfile.value = false;
	}
}

// ── Change login email ──
// BetterAuth's change-email flow (apps/api/convex/auth/auth.ts → user.changeEmail)
// never mutates the login email directly — it always requires a confirmation
// link to be followed first, so the page just requests the change and tells the
// user where the link was sent. The destination depends on whether the account's
// email is verified:
//  - verified accounts get a link at their CURRENT address (approve → a second
//    link is sent to the new address, and following that commits the change);
//  - unverified accounts get the link straight at the NEW address.
const newEmail = ref('');
const savingEmail = ref(false);
const emailRequested = ref(false);
// The address the first confirmation link is sent to (see above). null until a
// change has been requested.
const confirmationSentTo = ref<string | null>(null);
const isEmailVerified = computed(() => user.value?.emailVerified === true);
async function changeEmail() {
	const email = newEmail.value.trim().toLowerCase();
	if (!isValidEmail(email)) {
		showToast('Enter a valid email address', 'error');
		return;
	}
	if (email === (user.value?.email ?? '').toLowerCase()) {
		showToast('That is already your login email', 'error');
		return;
	}
	savingEmail.value = true;
	emailRequested.value = false;
	// Verified accounts get the first confirmation at their current address;
	// unverified accounts get it at the new one (see comment above + auth.ts).
	const destination = isEmailVerified.value ? (user.value?.email ?? email) : email;
	try {
		const res = await authClient.changeEmail({
			newEmail: email,
			callbackURL: '/dashboard/settings/account',
		});
		if (res.error) {
			showToast(res.error.message ?? 'Could not change email', 'error');
			return;
		}
		emailRequested.value = true;
		confirmationSentTo.value = destination;
		newEmail.value = '';
		showToast('Check your inbox to confirm the change');
	} catch {
		showToast('Could not change email', 'error');
	} finally {
		savingEmail.value = false;
	}
}

// ── Change password ──
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const savingPassword = ref(false);
async function changePassword() {
	if (newPassword.value.length < 10) {
		showToast('New password must be at least 10 characters', 'error');
		return;
	}
	if (newPassword.value !== confirmPassword.value) {
		showToast('New passwords do not match', 'error');
		return;
	}
	savingPassword.value = true;
	try {
		const res = await authClient.changePassword({
			currentPassword: currentPassword.value,
			newPassword: newPassword.value,
		});
		if (res.error) {
			showToast(res.error.message ?? 'Could not change password', 'error');
			return;
		}
		showToast('Password changed');
		currentPassword.value = '';
		newPassword.value = '';
		confirmPassword.value = '';
	} catch {
		showToast('Could not change password', 'error');
	} finally {
		savingPassword.value = false;
	}
}

// Get pending deletion request
const { data: pendingDeletion, isLoading: deletionLoading } = useConvexQuery(
	api.auth.accountManagement.getPendingDeletionRequest,
	() => {
		if (!userId.value) return 'skip';
		return { userId: userId.value };
	}
);

// Toast notifications (global)
const { showToast: showNotification } = useToast();

// Export state
const isExportingJson = ref(false);
const isExportingCsv = ref(false);

// Delete account state
const showDeleteModal = ref(false);
const deleteReason = ref('');
const deleteConfirmText = ref('');
const isDeleting = ref(false);

// Cancel deletion state
const isCancelling = ref(false);

// Mutations
const { run: requestDeletion } = useBackendOperation(api.auth.accountManagement.requestAccountDeletion, {
	label: 'Request account deletion',
});
const { run: cancelDeletion } = useBackendOperation(api.auth.accountManagement.cancelAccountDeletion, {
	label: 'Cancel account deletion',
});

// Export all data as JSON
const handleExportJson = async () => {
	if (!userId.value || !convex) return;

	isExportingJson.value = true;

	try {
		const data = await convex.query(api.auth.accountManagement.exportUserData, {
			userId: userId.value,
		});

		// Create and download JSON file
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `owlat-data-export-${new Date().toISOString().split('T')[0]}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);

		showNotification('Data exported successfully');
	} catch (error) {
		showNotification('Failed to export data', 'error');
	} finally {
		isExportingJson.value = false;
	}
};

// Export contacts as CSV
const handleExportCsv = async () => {
	if (!hasActiveOrganization.value || !convex) return;

	isExportingCsv.value = true;

	try {
		const data = await convex.query(api.auth.accountManagement.exportContactsForOrganization, {});

		// Build CSV headers — must match the fields returned by
		// exportContactsForOrganization (no subscription columns are returned).
		const baseHeaders = [
			'email',
			'firstName',
			'lastName',
			'source',
			'timezone',
			'createdAt',
			'updatedAt',
			'topics',
		];
		const allHeaders = [...baseHeaders, ...data.properties];

		// Generate CSV
		const sanitizedContacts = data.contacts.map((row: Record<string, unknown>) =>
			Object.fromEntries(
				Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? sanitizeCsvCell(v) : v])
			)
		);
		const csv = Papa.unparse({
			fields: allHeaders,
			data: sanitizedContacts,
		});

		// Create and download CSV file
		const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `contacts-export-${new Date().toISOString().split('T')[0]}.csv`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);

		showNotification('Contacts exported successfully');
	} catch (error) {
		showNotification('Failed to export contacts', 'error');
	} finally {
		isExportingCsv.value = false;
	}
};

// Request account deletion
const handleDeleteAccount = async () => {
	if (!userId.value) return;
	if (deleteConfirmText.value !== 'DELETE') return;

	isDeleting.value = true;

	const result = await requestDeletion({
		userId: userId.value,
		reason: deleteReason.value || undefined,
	});
	isDeleting.value = false;

	if (result === undefined) return;

	// The backend requestAccountDeletion mutation schedules the confirmation
	// email (internal.accountDeletionEmail.sendAccountDeletionEmail) before it
	// returns, so the copy below can promise it.
	showNotification('Account deletion request submitted. Check your email for confirmation.');
	showDeleteModal.value = false;
	deleteReason.value = '';
	deleteConfirmText.value = '';

	// `result` carries the scheduledForDeletion timestamp; nothing else to do
	// here — the confirmation email is already scheduled by the mutation above.
	void result;
};

// Cancel account deletion
const handleCancelDeletion = async () => {
	if (!userId.value) return;

	isCancelling.value = true;

	const result = await cancelDeletion({
		userId: userId.value,
	});
	isCancelling.value = false;

	if (result === undefined) return;

	showNotification('Account deletion cancelled successfully');
};

// Days remaining until deletion
const daysRemaining = computed(() => {
	if (!pendingDeletion.value) return 0;
	const now = Date.now();
	const remaining = pendingDeletion.value.scheduledForDeletion - now;
	return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/settings"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Settings
			</NuxtLink>
			<h1 class="text-2xl font-semibold text-text-primary">Account Management</h1>
			<p class="mt-1 text-text-secondary">Manage your profile, password, data, and account</p>
		</div>

		<!-- Loading State -->
		<div v-if="deletionLoading && !pendingDeletion" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading...</p>
			</div>
		</div>

		<div v-else class="space-y-8 max-w-4xl">
			<!-- Profile -->
			<div class="card">
				<h2 class="text-lg font-semibold text-text-primary mb-1">Profile</h2>
				<p class="text-sm text-text-secondary mb-4">Your display name, used as the sender identity.</p>
				<div class="flex items-end gap-3 max-w-md">
					<div class="flex-1">
						<UiInput id="profile-name" v-model="nameDraft" label="Name" placeholder="Your name" />
					</div>
					<UiButton :loading="savingProfile" :disabled="!nameDraft.trim()" @click="saveProfile">Save</UiButton>
				</div>
				<p class="text-xs text-text-tertiary mt-3">
					Signed in as <span class="font-medium text-text-secondary">{{ user?.email }}</span>.
				</p>
			</div>

			<!-- Change login email -->
			<div class="card">
				<h2 class="text-lg font-semibold text-text-primary mb-1">Login email</h2>
				<p v-if="isEmailVerified" class="text-sm text-text-secondary mb-4">
					Change the email address you use to sign in. We send an approval link to your
					current address; once you follow it we send a final confirmation link to the new
					address. Your login email only changes after that last link is followed.
				</p>
				<p v-else class="text-sm text-text-secondary mb-4">
					Change the email address you use to sign in. We send a confirmation link to the
					new address — your login email only changes once you follow it.
				</p>
				<form class="space-y-3 max-w-md" @submit.prevent="changeEmail">
					<UiInput
						id="new-email"
						v-model="newEmail"
						type="email"
						label="New email address"
						placeholder="you@example.com"
						autocomplete="email"
					/>
					<UiButton type="submit" :loading="savingEmail" :disabled="!newEmail.trim()">
						Send confirmation
					</UiButton>
				</form>
				<p v-if="emailRequested" class="text-xs text-success mt-3">
					We sent a confirmation link to <span class="font-medium">{{ confirmationSentTo }}</span>. Follow it to {{ isEmailVerified ? 'approve' : 'finish' }} changing your login email.
				</p>
			</div>

			<!-- Change Password -->
			<div class="card">
				<h2 class="text-lg font-semibold text-text-primary mb-1">Change password</h2>
				<p class="text-sm text-text-secondary mb-4">Update your password without signing out.</p>
				<form class="space-y-3 max-w-md" @submit.prevent="changePassword">
					<UiInput id="cur-pw" v-model="currentPassword" type="password" label="Current password" autocomplete="current-password" />
					<UiInput id="new-pw" v-model="newPassword" type="password" label="New password" autocomplete="new-password" />
					<UiInput id="confirm-pw" v-model="confirmPassword" type="password" label="Confirm new password" autocomplete="new-password" />
					<UiButton type="submit" :loading="savingPassword">Change password</UiButton>
				</form>
			</div>

			<!-- Pending Deletion Banner -->
			<div v-if="pendingDeletion" class="card p-0 overflow-hidden border-warning/30 bg-warning/5">
				<div class="px-6 py-4 border-b border-warning/20 bg-warning/10">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:alert-triangle" size="sm" variant="warning" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-warning">Account Deletion Pending</h2>
							<p class="text-sm text-warning/80">Your account is scheduled for deletion</p>
						</div>
					</div>
				</div>

				<div class="p-6">
					<div class="flex items-center gap-6 mb-6">
						<div class="flex items-center gap-2 text-text-secondary">
							<Icon name="lucide:calendar" class="w-4 h-4" />
							<span class="text-sm">
								Deletion date:
								<strong class="text-text-primary">{{
									formatDate(pendingDeletion.scheduledForDeletion, 'full')
								}}</strong>
							</span>
						</div>
						<div class="px-3 py-1 rounded-full bg-warning/20 text-warning text-sm font-medium">
							{{ daysRemaining }} days remaining
						</div>
					</div>

					<p class="text-text-secondary text-sm mb-6">
						Your account and all associated data will be permanently deleted after the grace period.
						You can cancel this deletion at any time before the scheduled date.
					</p>

					<button
						class="btn btn-primary gap-2"
						:disabled="isCancelling"
						@click="handleCancelDeletion"
					>
						<Icon v-if="isCancelling" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
						<Icon v-else name="lucide:x-circle" class="w-4 h-4" />
						{{ isCancelling ? 'Cancelling...' : 'Cancel Account Deletion' }}
					</button>
				</div>
			</div>

			<!-- Data Export Section -->
			<div class="card p-0 overflow-hidden">
				<div class="px-6 py-4 border-b border-border-subtle">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:download" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-text-primary">Export Your Data</h2>
							<p class="text-sm text-text-secondary">
								Download a copy of all your data in JSON or CSV format
							</p>
						</div>
					</div>
				</div>

				<div class="p-6">
					<p class="text-text-secondary text-sm mb-6">
						You can export your data at any time. The export includes your profile information, your
						personal mailbox and mail, drafts, connected external accounts, your chat messages, and —
						for the teams you belong to — contacts, campaigns, automations, and other associated data.
					</p>

					<div class="grid gap-4 sm:grid-cols-2">
						<!-- JSON Export -->
						<div class="card p-5 bg-bg-surface/50">
							<div class="flex items-start gap-4">
								<UiIconBox icon="lucide:file-json" size="lg" variant="brand" rounded="lg" />
								<div class="flex-1">
									<h3 class="font-medium text-text-primary mb-1">Complete Data Export</h3>
									<p class="text-xs text-text-tertiary mb-3">
										JSON format with all your data: your mailbox, mail, drafts, chat, connected
										accounts, plus your teams, contacts, campaigns, and more.
									</p>
									<button
										class="btn btn-secondary btn-sm gap-2"
										:disabled="isExportingJson"
										@click="handleExportJson"
									>
										<Icon v-if="isExportingJson" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
										<Icon v-else name="lucide:download" class="w-4 h-4" />
										{{ isExportingJson ? 'Exporting...' : 'Export JSON' }}
									</button>
								</div>
							</div>
						</div>

						<!-- CSV Export -->
						<div class="card p-5 bg-bg-surface/50">
							<div class="flex items-start gap-4">
								<UiIconBox icon="lucide:file-spreadsheet" size="lg" variant="brand" rounded="lg" />
								<div class="flex-1">
									<h3 class="font-medium text-text-primary mb-1">Contacts Export</h3>
									<p class="text-xs text-text-tertiary mb-3">
										CSV format for easy import into spreadsheets or other email tools.
									</p>
									<button
										class="btn btn-secondary btn-sm gap-2"
										:disabled="isExportingCsv || !hasActiveOrganization"
										@click="handleExportCsv"
									>
										<Icon v-if="isExportingCsv" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
										<Icon v-else name="lucide:download" class="w-4 h-4" />
										{{ isExportingCsv ? 'Exporting...' : 'Export CSV' }}
									</button>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>

			<!-- Delete Account Section -->
			<div v-if="!pendingDeletion" class="card p-0 overflow-hidden border-error/20">
				<div class="px-6 py-4 border-b border-error/10 bg-error/5">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:trash-2" size="sm" variant="error" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-error">Delete Account</h2>
							<p class="text-sm text-error/80">
								Permanently delete your account and all associated data
							</p>
						</div>
					</div>
				</div>

				<div class="p-6">
					<div class="mb-6">
						<p class="text-text-secondary text-sm mb-4">
							Deleting your account will permanently remove all your data after a 30-day grace
							period. During this period, you can cancel the deletion at any time.
						</p>
						<p class="text-text-secondary text-sm">
							<strong class="text-text-primary">What will be deleted:</strong>
						</p>
						<!-- Owners trigger the org-deletion walker, so their team's data goes too. -->
						<ul
							v-if="isOwner"
							class="list-disc list-inside text-sm text-text-tertiary mt-2 space-y-1"
						>
							<li>Your profile and account information</li>
							<li>All teams you own and their data</li>
							<li>Contacts, campaigns, and email templates</li>
							<li>Automations and workflows</li>
							<li>API keys and webhook configurations</li>
							<li>Analytics and activity history</li>
						</ul>
						<!--
							Members are routed to member-erasure, which removes only their
							personal data; org-owned records (contacts, campaigns, API keys,
							webhooks, analytics) belong to the team and are not deleted.
						-->
						<ul v-else class="list-disc list-inside text-sm text-text-tertiary mt-2 space-y-1">
							<li>Your profile and account information</li>
							<li>Your personal mailbox, mail, and drafts</li>
							<li>Connected external email accounts and app passwords</li>
							<li>Your chat messages and team memberships</li>
						</ul>
						<p v-if="!isOwner" class="text-xs text-text-tertiary mt-3">
							Data owned by your teams — contacts, campaigns, API keys, webhooks, and
							analytics — belongs to the team and is not removed by deleting your account.
						</p>
					</div>

					<button
						class="btn gap-2 bg-error/10 text-error hover:bg-error/20 border border-error/20"
						@click="showDeleteModal = true"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
						Request Account Deletion
					</button>
				</div>
			</div>
		</div>

		<!-- Delete Confirmation Modal -->
		<UiModal
			:open="showDeleteModal"
			size="lg"
			:closable="!isDeleting"
			:persistent="isDeleting"
			@update:open="(v) => { if (!v) showDeleteModal = false; }"
		>
			<!-- Header -->
			<div class="flex items-center gap-3 mb-6">
				<UiIconBox icon="lucide:alert-triangle" size="sm" variant="error" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Delete Your Account</h2>
					<p class="text-sm text-text-secondary">This action has a 30-day grace period</p>
				</div>
			</div>

			<!-- Content -->
			<div class="p-4 rounded-xl bg-error/5 border border-error/20 mb-6">
				<p class="text-sm text-error">
					<strong>Warning:</strong> After the 30-day grace period, your account and all
					associated data will be permanently deleted. This action cannot be undone.
				</p>
			</div>

			<!-- Optional reason -->
			<div class="mb-6">
				<label class="label" for="delete-reason"> Reason for leaving (optional) </label>
				<textarea
					id="delete-reason"
					v-model="deleteReason"
					class="input min-h-[100px] resize-none"
					placeholder="Help us improve by sharing why you're leaving..."
				/>
			</div>

			<!-- Confirmation input -->
			<div>
				<label class="label" for="confirm-delete">
					Type <strong class="text-error">DELETE</strong> to confirm
				</label>
				<input
					id="confirm-delete"
					v-model="deleteConfirmText"
					type="text"
					class="input"
					placeholder="DELETE"
					autocomplete="off"
				/>
			</div>

			<template #footer>
				<button
					type="button"
					class="btn btn-ghost"
					:disabled="isDeleting"
					@click="showDeleteModal = false"
				>
					Cancel
				</button>
				<button
					type="button"
					class="btn gap-2 bg-error text-white hover:bg-error/90"
					:disabled="isDeleting || deleteConfirmText !== 'DELETE'"
					@click="handleDeleteAccount"
				>
					<Icon v-if="isDeleting" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					<Icon v-else name="lucide:trash-2" class="w-4 h-4" />
					{{ isDeleting ? 'Processing...' : 'Delete My Account' }}
				</button>
			</template>
		</UiModal>
	</div>
</template>
