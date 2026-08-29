<script setup lang="ts">
import { sanitizeCsvCell } from '@owlat/shared';
import { api } from '@owlat/api';
import Papa from 'papaparse';
import { isValidEmail } from '~/utils/validation';
import { authClient } from '~/lib/auth-client';
import { writeAccountJsonExport } from '~/utils/accountJsonExport';
import {
	isSaveFilePickerCancellation,
	openIncrementalJsonDownload,
} from '~/utils/incrementalJsonDownload';
import {
	accountExportPercent,
	buildAccountExportManifest,
	plannedRowTotal,
	type AccountExportManifestRow,
} from '~/utils/accountExportProgress';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.account.pageTitle') });

definePageMeta({
	layout: 'preferences',
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
	{ immediate: true }
);
const savingProfile = ref(false);
async function saveProfile() {
	const name = nameDraft.value.trim();
	if (!name) return;
	savingProfile.value = true;
	try {
		const res = await authClient.updateUser({ name });
		if (res.error)
			showToast(
				res.error.message ?? t('dashboard.preferences.account.profileUpdateFailed'),
				'error'
			);
		else showToast(t('dashboard.preferences.account.profileUpdated'));
	} catch {
		showToast(t('dashboard.preferences.account.profileUpdateFailed'), 'error');
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
		showToast(t('dashboard.preferences.account.emailInvalid'), 'error');
		return;
	}
	if (email === (user.value?.email ?? '').toLowerCase()) {
		showToast(t('dashboard.preferences.account.emailUnchanged'), 'error');
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
			callbackURL: '/dashboard/preferences/account',
		});
		if (res.error) {
			showToast(res.error.message ?? t('dashboard.preferences.account.emailChangeFailed'), 'error');
			return;
		}
		emailRequested.value = true;
		confirmationSentTo.value = destination;
		newEmail.value = '';
		showToast(t('dashboard.preferences.account.emailChangeRequested'));
	} catch {
		showToast(t('dashboard.preferences.account.emailChangeFailed'), 'error');
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
		showToast(t('dashboard.preferences.account.passwordTooShort'), 'error');
		return;
	}
	if (newPassword.value !== confirmPassword.value) {
		showToast(t('dashboard.preferences.account.passwordsDoNotMatch'), 'error');
		return;
	}
	savingPassword.value = true;
	try {
		const res = await authClient.changePassword({
			currentPassword: currentPassword.value,
			newPassword: newPassword.value,
		});
		if (res.error) {
			showToast(
				res.error.message ?? t('dashboard.preferences.account.passwordChangeFailed'),
				'error'
			);
			return;
		}
		showToast(t('dashboard.preferences.account.passwordChanged'));
		currentPassword.value = '';
		newPassword.value = '';
		confirmPassword.value = '';
	} catch {
		showToast(t('dashboard.preferences.account.passwordChangeFailed'), 'error');
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

// ── Export manifest + progress (idea 67) ───────────────────────────────────
// The manifest is read BEFORE the run so the card can say what the file will
// contain and how much of it there is; the bar then counts rows actually
// written against that plan. Both are pure derivations in
// `~/utils/accountExportProgress`.
const exportManifest = ref<AccountExportManifestRow[]>([]);
const isManifestLoading = ref(false);
const exportedRows = ref(0);
const plannedRows = computed(() => plannedRowTotal(exportManifest.value));
const exportPercent = computed(() =>
	accountExportPercent({ rowsWritten: exportedRows.value, plannedRows: plannedRows.value })
);

async function loadExportManifest() {
	if (!userId.value || !convex) return;
	isManifestLoading.value = true;
	try {
		const plan = await convex.action(api.auth.accountExport.getExportPlan, {
			userId: userId.value,
		});
		exportManifest.value = buildAccountExportManifest(plan);
	} catch {
		// A manifest is an extra: failing to read it must never block the export
		// itself, so the card falls back to "we could not count this in advance".
		exportManifest.value = [];
	} finally {
		isManifestLoading.value = false;
	}
}
watch(userId, (id) => void (id ? loadExportManifest() : undefined), { immediate: true });

// Delete account state
const showDeleteModal = ref(false);
const deleteReason = ref('');
const deleteConfirmText = ref('');
const isDeleting = ref(false);

// Cancel deletion state
const isCancelling = ref(false);

// Mutations
const { run: requestDeletion } = useBackendOperation(
	api.auth.accountManagement.requestAccountDeletion,
	{
		label: () => t('dashboard.preferences.account.requestDeletionOperation'),
	}
);
const { run: cancelDeletion } = useBackendOperation(
	api.auth.accountManagement.cancelAccountDeletion,
	{
		label: () => t('dashboard.preferences.account.cancelDeletionOperation'),
	}
);

// Export all data as JSON
const handleExportJson = async () => {
	if (!userId.value || !convex) return;

	isExportingJson.value = true;
	exportedRows.value = 0;

	try {
		const filename = `owlat-data-export-${new Date().toISOString().split('T')[0]}.json`;
		// The native picker requires the original click's transient user activation,
		// so open the destination before the first network request.
		const sink = await openIncrementalJsonDownload(filename);
		await writeAccountJsonExport(convex, userId.value, sink, () => {
			exportedRows.value += 1;
		});

		showNotification(t('dashboard.preferences.account.exportJsonSuccess'));
	} catch (error) {
		if (isSaveFilePickerCancellation(error)) return;
		showNotification(t('dashboard.preferences.account.exportJsonFailed'), 'error');
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

		showNotification(t('dashboard.preferences.account.exportCsvSuccess'));
	} catch (error) {
		showNotification(t('dashboard.preferences.account.exportCsvFailed'), 'error');
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

	if (!result.ok) return;

	// The backend requestAccountDeletion mutation schedules the confirmation
	// email (internal.accountDeletionEmail.sendAccountDeletionEmail) before it
	// returns, so the copy below can promise it.
	showNotification(t('dashboard.preferences.account.deletionRequested'));
	showDeleteModal.value = false;
	deleteReason.value = '';
	deleteConfirmText.value = '';

	// `result.result` carries the scheduledForDeletion timestamp; nothing else to do
	// here — the confirmation email is already scheduled by the mutation above.
	void result.result;
};

// Cancel account deletion
const handleCancelDeletion = async () => {
	if (!userId.value) return;

	isCancelling.value = true;

	const result = await cancelDeletion({
		userId: userId.value,
	});
	isCancelling.value = false;

	if (!result.ok) return;

	showNotification(t('dashboard.preferences.account.deletionCancelled'));
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
	<div>
		<p class="mb-6 text-text-secondary">{{ t('dashboard.preferences.account.subheading') }}</p>

		<!-- Loading State -->
		<div v-if="deletionLoading && !pendingDeletion" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">{{ t('common.loading') }}</p>
			</div>
		</div>

		<div v-else class="space-y-8 max-w-4xl">
			<!-- Profile -->
			<div class="card">
				<h2 class="text-lg font-semibold text-text-primary mb-1">
					{{ t('dashboard.preferences.account.profileTitle') }}
				</h2>
				<p class="text-sm text-text-secondary mb-4">
					{{ t('dashboard.preferences.account.profileDescription') }}
				</p>
				<div class="flex items-end gap-3 max-w-md">
					<div class="flex-1">
						<UiInput
							id="profile-name"
							v-model="nameDraft"
							:label="t('common.name')"
							:placeholder="t('dashboard.preferences.account.namePlaceholder')"
						/>
					</div>
					<UiButton :loading="savingProfile" :disabled="!nameDraft.trim()" @click="saveProfile">{{
						t('common.save')
					}}</UiButton>
				</div>
				<I18nT
					keypath="dashboard.preferences.account.signedInAs"
					tag="p"
					scope="global"
					class="text-xs text-text-tertiary mt-3"
				>
					<template #email>
						<span class="font-medium text-text-secondary">{{ user?.email }}</span>
					</template>
				</I18nT>
			</div>

			<!-- Change login email -->
			<div class="card">
				<h2 class="text-lg font-semibold text-text-primary mb-1">
					{{ t('dashboard.preferences.account.loginEmailTitle') }}
				</h2>
				<p v-if="isEmailVerified" class="text-sm text-text-secondary mb-4">
					{{ t('dashboard.preferences.account.loginEmailVerifiedDescription') }}
				</p>
				<p v-else class="text-sm text-text-secondary mb-4">
					{{ t('dashboard.preferences.account.loginEmailUnverifiedDescription') }}
				</p>
				<form class="space-y-3 max-w-md" @submit.prevent="changeEmail">
					<UiInput
						id="new-email"
						v-model="newEmail"
						type="email"
						:label="t('dashboard.preferences.account.newEmailLabel')"
						:placeholder="t('auth.fields.emailPlaceholder')"
						autocomplete="email"
					/>
					<UiButton type="submit" :loading="savingEmail" :disabled="!newEmail.trim()">
						{{ t('dashboard.preferences.account.sendConfirmation') }}
					</UiButton>
				</form>
				<I18nT
					v-if="emailRequested"
					:keypath="
						isEmailVerified
							? 'dashboard.preferences.account.confirmationSentApprove'
							: 'dashboard.preferences.account.confirmationSentFinish'
					"
					tag="p"
					scope="global"
					class="text-xs text-success mt-3"
				>
					<template #email>
						<span class="font-medium">{{ confirmationSentTo }}</span>
					</template>
				</I18nT>
			</div>

			<!-- Change Password -->
			<div class="card">
				<h2 class="text-lg font-semibold text-text-primary mb-1">
					{{ t('dashboard.preferences.account.changePasswordTitle') }}
				</h2>
				<p class="text-sm text-text-secondary mb-4">
					{{ t('dashboard.preferences.account.changePasswordDescription') }}
				</p>
				<form class="space-y-3 max-w-md" @submit.prevent="changePassword">
					<UiInput
						id="cur-pw"
						v-model="currentPassword"
						type="password"
						:label="t('dashboard.preferences.account.currentPasswordLabel')"
						autocomplete="current-password"
					/>
					<UiInput
						id="new-pw"
						v-model="newPassword"
						type="password"
						:label="t('dashboard.preferences.account.newPasswordLabel')"
						autocomplete="new-password"
					/>
					<UiInput
						id="confirm-pw"
						v-model="confirmPassword"
						type="password"
						:label="t('dashboard.preferences.account.confirmPasswordLabel')"
						autocomplete="new-password"
					/>
					<UiButton type="submit" :loading="savingPassword">
						{{ t('dashboard.preferences.account.changePasswordSubmit') }}
					</UiButton>
				</form>
				<!--
					The password is one of two things guarding this account, and until
					now the other one had no entry point anywhere in the app. Sessions
					and two-factor live one click from the field that sets the first.
				-->
				<p class="text-sm text-text-secondary mt-4 pt-4 border-t border-border-subtle">
					<NuxtLink to="/dashboard/preferences/security" class="link">
						{{ t('dashboard.preferences.account.securityLink') }}
					</NuxtLink>
				</p>
			</div>

			<!-- Pending Deletion Banner -->
			<div v-if="pendingDeletion" class="card p-0 overflow-hidden border-warning/30 bg-warning/5">
				<div class="px-6 py-4 border-b border-warning/20 bg-warning/10">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:alert-triangle" size="sm" variant="warning" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-warning">
								{{ t('dashboard.preferences.account.deletionPendingTitle') }}
							</h2>
							<p class="text-sm text-warning/80">
								{{ t('dashboard.preferences.account.deletionPendingSubtitle') }}
							</p>
						</div>
					</div>
				</div>

				<div class="p-6">
					<div class="flex items-center gap-6 mb-6">
						<div class="flex items-center gap-2 text-text-secondary">
							<Icon name="lucide:calendar" class="w-4 h-4" />
							<I18nT
								keypath="dashboard.preferences.account.deletionDate"
								tag="span"
								scope="global"
								class="text-sm"
							>
								<template #date>
									<strong class="text-text-primary">{{
										formatDate(pendingDeletion.scheduledForDeletion, 'full')
									}}</strong>
								</template>
							</I18nT>
						</div>
						<div class="px-3 py-1 rounded-full bg-warning/20 text-warning text-sm font-medium">
							{{ t('dashboard.preferences.account.daysRemaining', { days: daysRemaining }) }}
						</div>
					</div>

					<p class="text-text-secondary text-sm mb-6">
						{{ t('dashboard.preferences.account.deletionPendingBody') }}
					</p>

					<UiButton class="gap-2" :disabled="isCancelling" @click="handleCancelDeletion">
						<Icon
							v-if="isCancelling"
							name="lucide:loader-2"
							class="w-4 h-4 animate-spin motion-reduce:animate-none"
						/>
						<Icon v-else name="lucide:x-circle" class="w-4 h-4" />
						{{
							isCancelling
								? t('dashboard.preferences.account.cancellingDeletion')
								: t('dashboard.preferences.account.cancelDeletionAction')
						}}
					</UiButton>
				</div>
			</div>

			<!-- Data Export Section -->
			<div class="card p-0 overflow-hidden">
				<div class="px-6 py-4 border-b border-border-subtle">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:download" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.preferences.account.exportTitle') }}
							</h2>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.preferences.account.exportSubtitle') }}
							</p>
						</div>
					</div>
				</div>

				<div class="p-6">
					<p class="text-text-secondary text-sm mb-6">
						{{ t('dashboard.preferences.account.exportBody') }}
					</p>

					<div class="grid gap-4 sm:grid-cols-2">
						<!-- JSON Export -->
						<div class="card p-5 bg-bg-surface/50">
							<div class="flex items-start gap-4">
								<UiIconBox icon="lucide:file-json" size="lg" variant="brand" rounded="lg" />
								<div class="flex-1">
									<h3 class="font-medium text-text-primary mb-1">
										{{ t('dashboard.preferences.account.exportJsonTitle') }}
									</h3>
									<p class="text-xs text-text-tertiary mb-3">
										{{ t('dashboard.preferences.account.exportJsonDescription') }}
									</p>
									<UiButton
										variant="secondary"
										size="sm"
										class="gap-2"
										:disabled="isExportingJson"
										@click="handleExportJson"
									>
										<Icon
											v-if="isExportingJson"
											name="lucide:loader-2"
											class="w-4 h-4 animate-spin motion-reduce:animate-none"
										/>
										<Icon v-else name="lucide:download" class="w-4 h-4" />
										{{
											isExportingJson
												? t('dashboard.preferences.account.exporting')
												: t('dashboard.preferences.account.exportJsonAction')
										}}
									</UiButton>
									<PreferencesExportManifest
										:rows="exportManifest"
										:is-loading="isManifestLoading"
										:is-exporting="isExportingJson"
										:rows-written="exportedRows"
										:percent="exportPercent"
									/>
								</div>
							</div>
						</div>

						<!-- CSV Export -->
						<div class="card p-5 bg-bg-surface/50">
							<div class="flex items-start gap-4">
								<UiIconBox icon="lucide:file-spreadsheet" size="lg" variant="brand" rounded="lg" />
								<div class="flex-1">
									<h3 class="font-medium text-text-primary mb-1">
										{{ t('dashboard.preferences.account.exportCsvTitle') }}
									</h3>
									<p class="text-xs text-text-tertiary mb-3">
										{{ t('dashboard.preferences.account.exportCsvDescription') }}
									</p>
									<UiButton
										variant="secondary"
										size="sm"
										class="gap-2"
										:disabled="isExportingCsv || !hasActiveOrganization"
										@click="handleExportCsv"
									>
										<Icon
											v-if="isExportingCsv"
											name="lucide:loader-2"
											class="w-4 h-4 animate-spin motion-reduce:animate-none"
										/>
										<Icon v-else name="lucide:download" class="w-4 h-4" />
										{{
											isExportingCsv
												? t('dashboard.preferences.account.exporting')
												: t('dashboard.preferences.account.exportCsvAction')
										}}
									</UiButton>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>

			<!--
				What is kept, for how long, and the mail archive. Between the export
				and the deletion on purpose: it answers the question a person has
				once they start thinking about either.
			-->
			<PreferencesYourData />

			<!-- Delete Account Section -->
			<div v-if="!pendingDeletion" class="card p-0 overflow-hidden border-error/20">
				<div class="px-6 py-4 border-b border-error/10 bg-error/5">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:trash-2" size="sm" variant="error" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-error">
								{{ t('dashboard.preferences.account.deleteAccountTitle') }}
							</h2>
							<p class="text-sm text-error/80">
								{{ t('dashboard.preferences.account.deleteAccountSubtitle') }}
							</p>
						</div>
					</div>
				</div>

				<div class="p-6">
					<div class="mb-6">
						<p class="text-text-secondary text-sm mb-4">
							{{ t('dashboard.preferences.account.deleteAccountBody') }}
						</p>
						<p class="text-text-secondary text-sm">
							<strong class="text-text-primary">
								{{ t('dashboard.preferences.account.whatWillBeDeleted') }}
							</strong>
						</p>
						<!-- Owners trigger the org-deletion walker, so their team's data goes too. -->
						<ul
							v-if="isOwner"
							class="list-disc list-inside text-sm text-text-tertiary mt-2 space-y-1"
						>
							<li>{{ t('dashboard.preferences.account.deletedItems.profile') }}</li>
							<li>{{ t('dashboard.preferences.account.deletedItems.ownedTeams') }}</li>
							<li>{{ t('dashboard.preferences.account.deletedItems.contacts') }}</li>
							<li>{{ t('dashboard.preferences.account.deletedItems.automations') }}</li>
							<li>{{ t('dashboard.preferences.account.deletedItems.apiKeys') }}</li>
							<li>{{ t('dashboard.preferences.account.deletedItems.analytics') }}</li>
						</ul>
						<!--
							Members are routed to member-erasure, which removes only their
							personal data; org-owned records (contacts, campaigns, API keys,
							webhooks, analytics) belong to the team and are not deleted.
						-->
						<ul v-else class="list-disc list-inside text-sm text-text-tertiary mt-2 space-y-1">
							<li>{{ t('dashboard.preferences.account.deletedItems.profile') }}</li>
							<li>{{ t('dashboard.preferences.account.deletedItems.personalMailbox') }}</li>
							<li>{{ t('dashboard.preferences.account.deletedItems.externalAccounts') }}</li>
							<li>{{ t('dashboard.preferences.account.deletedItems.chatMemberships') }}</li>
						</ul>
						<p v-if="!isOwner" class="text-xs text-text-tertiary mt-3">
							{{ t('dashboard.preferences.account.memberDataNote') }}
						</p>
					</div>

					<UiButton
						class="gap-2 bg-error/10 text-error hover:bg-error/20 border border-error/20"
						@click="showDeleteModal = true"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
						{{ t('dashboard.preferences.account.requestDeletionAction') }}
					</UiButton>
				</div>
			</div>
		</div>

		<!-- Delete Confirmation Modal -->
		<UiModal
			:open="showDeleteModal"
			size="lg"
			:closable="!isDeleting"
			:persistent="isDeleting"
			@update:open="
				(v) => {
					if (!v) showDeleteModal = false;
				}
			"
		>
			<!-- Header -->
			<div class="flex items-center gap-3 mb-6">
				<UiIconBox icon="lucide:alert-triangle" size="sm" variant="error" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('dashboard.preferences.account.deleteModalTitle') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.preferences.account.deleteModalSubtitle') }}
					</p>
				</div>
			</div>

			<!-- Content -->
			<div class="p-4 rounded-xl bg-error/5 border border-error/20 mb-6">
				<I18nT
					keypath="dashboard.preferences.account.deleteModalWarning"
					tag="p"
					scope="global"
					class="text-sm text-error"
				>
					<template #warning>
						<strong>{{ t('dashboard.preferences.account.warningLabel') }}</strong>
					</template>
				</I18nT>
			</div>

			<!-- Optional reason -->
			<div class="mb-6">
				<label class="label" for="delete-reason">
					{{ t('dashboard.preferences.account.reasonLabel') }}
				</label>
				<textarea
					id="delete-reason"
					v-model="deleteReason"
					class="input min-h-[100px] resize-none"
					:placeholder="t('dashboard.preferences.account.reasonPlaceholder')"
				/>
			</div>

			<!-- Confirmation input -->
			<div>
				<I18nT
					keypath="dashboard.preferences.account.confirmDeleteLabel"
					tag="label"
					scope="global"
					class="label"
					for="confirm-delete"
				>
					<template #word><strong class="text-error">DELETE</strong></template>
				</I18nT>
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
				<UiButton
					variant="ghost"
					type="button"
					:disabled="isDeleting"
					@click="showDeleteModal = false"
				>
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					variant="danger"
					type="button"
					class="gap-2"
					:disabled="isDeleting || deleteConfirmText !== 'DELETE'"
					@click="handleDeleteAccount"
				>
					<Icon
						v-if="isDeleting"
						name="lucide:loader-2"
						class="w-4 h-4 animate-spin motion-reduce:animate-none"
					/>
					<Icon v-else name="lucide:trash-2" class="w-4 h-4" />
					{{
						isDeleting
							? t('dashboard.preferences.account.processing')
							: t('dashboard.preferences.account.deleteMyAccount')
					}}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
