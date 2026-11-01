<script setup lang="ts">
import { api } from '@owlat/api';
import PreferencesChangePassword from '~/components/preferences/PreferencesChangePassword.vue';
import PreferencesDataExport from '~/components/preferences/PreferencesDataExport.vue';
import PreferencesDeleteAccount from '~/components/preferences/PreferencesDeleteAccount.vue';
import PreferencesDeleteAccountModal from '~/components/preferences/PreferencesDeleteAccountModal.vue';
import PreferencesLoginEmail from '~/components/preferences/PreferencesLoginEmail.vue';
import PreferencesPendingDeletion from '~/components/preferences/PreferencesPendingDeletion.vue';
import { useAccountExport } from '~/composables/preferences/useAccountExport';
import { authClient } from '~/lib/auth-client';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.account.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
});

const { hasActiveOrganization, role } = useOrganizationContext();

// Mail exists on this instance (hosted or connected): the daily brief is mail.
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const hasMail = computed(() => isFeatureEnabled('postbox') || isFeatureEnabled('mail.external'));
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
const { showToast } = useToast();

// ── Profile (display name) ──
const nameDraft = ref('');
// The name we know is persisted. Tracked separately from `user.name` because
// `authClient.updateUser` does not synchronously refresh the session object this
// page reads, so comparing the draft against the session would report a
// just-saved name as still dirty.
const savedName = ref('');
watch(
	user,
	(u) => {
		if (u && !nameDraft.value) nameDraft.value = u.name ?? '';
		if (u && !savedName.value) savedName.value = u.name ?? '';
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
		else {
			savedName.value = name;
			showToast(t('dashboard.preferences.account.profileUpdated'));
		}
	} catch {
		showToast(t('dashboard.preferences.account.profileUpdateFailed'), 'error');
	} finally {
		savingProfile.value = false;
	}
}

// ── Unsaved-changes guard ───────────────────────────────────────────
// The one DOCUMENT edit on this page is the display name — a value you changed
// and have not persisted. The email and password fields below are request
// flows: their "save" mails a confirmation link or rotates a credential, and
// neither is something a navigation prompt should fire on the user's behalf. So
// the guard watches the name draft alone, and its Save runs the same
// `saveProfile` the card's own button runs.
const isProfileDirty = computed(
	() => nameDraft.value.trim() !== '' && nameDraft.value.trim() !== savedName.value.trim()
);

const {
	showDialog: showUnsavedDialog,
	isSavingBeforeLeave,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	setHasChanges,
} = useUnsavedChanges({
	onSave: async () => {
		await saveProfile();
		// `saveProfile` advances `savedName` only when the write landed, so a
		// still-dirty draft means the save failed and the user stays here.
		if (isProfileDirty.value) throw new Error('Save failed');
	},
});

watch(isProfileDirty, (dirty) => setHasChanges(dirty), { immediate: true });

// Get pending deletion request
const {
	data: pendingDeletion,
	isLoading: deletionLoading,
	error: deletionError,
	refetch: refetchDeletion,
} = useConvexQuery(api.auth.accountManagement.getPendingDeletionRequest, () => {
	if (!userId.value) return 'skip';
	return { userId: userId.value };
});

// Toast notifications (global)
const { showToast: showNotification } = useToast();

// Export: the manifest is read as the page opens; the exports run on demand.
const {
	isExportingJson,
	isExportingCsv,
	exportManifest,
	isManifestLoading,
	exportedRows,
	exportPercent,
	handleExportJson,
	handleExportCsv,
} = useAccountExport({ userId, hasActiveOrganization });

// Delete account modal (owns its reason, confirmation and request)
const showDeleteModal = ref(false);

// Cancel deletion state
const isCancelling = ref(false);

// Mutations
const { run: cancelDeletion } = useBackendOperation(
	api.auth.accountManagement.cancelAccountDeletion,
	{
		label: () => t('dashboard.preferences.account.cancelDeletionOperation'),
	}
);

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

		<!--
			First load: a content-shaped placeholder at the geometry of the cards
			below, rather than a centred spinner that blanks the page and then
			reflows. Same idiom the rest of the settings group loads with.
		-->
		<div
			v-if="deletionLoading && !pendingDeletion"
			class="space-y-8 max-w-4xl"
			role="status"
			aria-busy="true"
			:aria-label="t('common.loading')"
		>
			<div v-for="card in 3" :key="card" class="card space-y-4">
				<UiSkeleton class="h-5 w-40" />
				<UiSkeletonText :lines="2" size="sm" last-line-width="w-1/2" />
				<div class="flex items-end gap-3 max-w-md">
					<UiSkeleton class="h-10 flex-1 rounded-lg" />
					<UiSkeleton class="h-10 w-20 rounded-lg" />
				</div>
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
			<PreferencesLoginEmail />

			<!-- Change Password -->
			<PreferencesChangePassword />

			<!-- Daily brief by email: opt-in delivery of the digest that otherwise
			     only exists at the top of Today. -->
			<PostboxDailyBriefSettings v-if="hasMail" />

			<!-- A failed read says nothing about a pending deletion: neither the
			     banner nor "Request deletion" may stand in for the answer. -->
			<UiQueryBoundary v-if="deletionError" :error="deletionError" @retry="refetchDeletion" />

			<!-- Pending Deletion Banner -->
			<PreferencesPendingDeletion
				v-else-if="pendingDeletion"
				:scheduled-for-deletion="pendingDeletion.scheduledForDeletion"
				:days-remaining="daysRemaining"
				:is-cancelling="isCancelling"
				@cancel="handleCancelDeletion"
			/>

			<!-- Data Export Section -->
			<PreferencesDataExport
				:is-exporting-json="isExportingJson"
				:is-exporting-csv="isExportingCsv"
				:can-export-csv="hasActiveOrganization"
				:manifest="exportManifest"
				:is-manifest-loading="isManifestLoading"
				:exported-rows="exportedRows"
				:export-percent="exportPercent"
				@export-json="handleExportJson"
				@export-csv="handleExportCsv"
			/>

			<!--
				What is kept, for how long, and the mail archive. Between the export
				and the deletion on purpose: it answers the question a person has
				once they start thinking about either.
			-->
			<PreferencesYourData />

			<!-- Delete Account Section -->
			<PreferencesDeleteAccount
				v-if="!pendingDeletion && !deletionError"
				:is-owner="isOwner"
				@request="showDeleteModal = true"
			/>
		</div>

		<!-- Delete Confirmation Modal -->
		<PreferencesDeleteAccountModal v-model:open="showDeleteModal" :user-id="userId" />

		<!-- Unsaved Changes Dialog -->
		<UiUnsavedChangesDialog
			:show="showUnsavedDialog"
			:saving="isSavingBeforeLeave"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>
	</div>
</template>
