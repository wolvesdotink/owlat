<script setup lang="ts">
import { api } from '@owlat/api';
import { UnsavedChangesDialog } from '@owlat/email-builder';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { isValidEmail } from '~/utils/validation';
import { unverifiedFromDomainWarning } from '~/utils/fromEmailDomain';

useHead({ title: 'General instance settings — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

/**
 * The connected-workspaces manager is a DESKTOP-ONLY surface: the Slack-style
 * list of Owlat instances this device is signed in to, which only exists inside
 * the Tauri shell. It arrived here with the old Workspace settings page, whose
 * sections this page absorbed, and it is deliberately outside the
 * `hasActiveOrganization` branch below — the workspaces on this device are a
 * property of the device, not of whichever organization is active.
 */
const isDesktop = isDesktopRuntime();

// Get BetterAuth organization for name updates
const { organization, update: updateOrganization } = useOrganization();

// Get organization settings with real-time updates
const {
	data: organizationSettings,
	isLoading: organizationSettingsLoading,
	error: organizationSettingsError,
} = useOrganizationQuery(api.workspaces.settings.get);

// Verified sending domains — used to warn when the Default From Email's domain
// is not one this deployment is authorized to send from.
const { data: verifiedDomains } = useOrganizationQuery(api.domains.domains.listVerified);

const isLoading = computed(() => organizationLoading.value || organizationSettingsLoading.value);

// Mutations
const { run: updateOrganizationSettings } = useBackendOperation(api.workspaces.settings.update, {
	label: 'Save settings',
});
const { run: setFeatureFlag } = useBackendOperation(api.workspaces.featureFlags.setFeatureFlag, {
	label: 'Toggle campaign archives',
});

// Feature flag state — archive default lives on `campaigns.archive`, not on instanceSettings
const { flags } = useFeatureFlag();

// Form state
const form = reactive({
	name: '',
	timezone: '',
	defaultFromName: '',
	defaultFromEmail: '',
	archiveEnabled: false,
});

const formErrors = reactive({
	name: '',
	defaultFromEmail: '',
});

// Non-blocking warning when the From email's domain is not a verified sending
// domain. Only shown once the address is a syntactically valid email, so it
// doesn't flicker while the operator is mid-type.
const fromDomainWarning = computed(() => {
	if (!isValidEmail(form.defaultFromEmail)) return null;
	return unverifiedFromDomainWarning(
		form.defaultFromEmail,
		verifiedDomains.value?.map((d) => d.domain)
	);
});

// Swap the From email onto a verified domain, preserving the local part the
// operator already typed (defaulting to "hello" when the field is empty).
function applyVerifiedDomain(domain: string) {
	const local = form.defaultFromEmail.split('@')[0]?.trim() || 'hello';
	form.defaultFromEmail = `${local}@${domain}`;
}

// Track if form has been modified
const isFormDirty = ref(false);
const isSaving = ref(false);

// Common timezones for dropdown
const timezones = [
	{ value: '', label: 'Select timezone...' },
	{ value: 'America/New_York', label: 'Eastern Time (US & Canada)' },
	{ value: 'America/Chicago', label: 'Central Time (US & Canada)' },
	{ value: 'America/Denver', label: 'Mountain Time (US & Canada)' },
	{ value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)' },
	{ value: 'America/Anchorage', label: 'Alaska' },
	{ value: 'Pacific/Honolulu', label: 'Hawaii' },
	{ value: 'America/Phoenix', label: 'Arizona' },
	{ value: 'America/Toronto', label: 'Eastern Time (Canada)' },
	{ value: 'America/Vancouver', label: 'Pacific Time (Canada)' },
	{ value: 'Europe/London', label: 'London' },
	{ value: 'Europe/Paris', label: 'Paris, Berlin, Amsterdam' },
	{ value: 'Europe/Berlin', label: 'Berlin, Frankfurt' },
	{ value: 'Europe/Amsterdam', label: 'Amsterdam' },
	{ value: 'Europe/Madrid', label: 'Madrid' },
	{ value: 'Europe/Rome', label: 'Rome, Milan' },
	{ value: 'Europe/Zurich', label: 'Zurich, Geneva' },
	{ value: 'Europe/Stockholm', label: 'Stockholm' },
	{ value: 'Europe/Warsaw', label: 'Warsaw' },
	{ value: 'Europe/Moscow', label: 'Moscow' },
	{ value: 'Asia/Dubai', label: 'Dubai' },
	{ value: 'Asia/Kolkata', label: 'Mumbai, New Delhi' },
	{ value: 'Asia/Singapore', label: 'Singapore' },
	{ value: 'Asia/Hong_Kong', label: 'Hong Kong' },
	{ value: 'Asia/Shanghai', label: 'Shanghai, Beijing' },
	{ value: 'Asia/Tokyo', label: 'Tokyo' },
	{ value: 'Asia/Seoul', label: 'Seoul' },
	{ value: 'Australia/Sydney', label: 'Sydney' },
	{ value: 'Australia/Melbourne', label: 'Melbourne' },
	{ value: 'Australia/Brisbane', label: 'Brisbane' },
	{ value: 'Australia/Perth', label: 'Perth' },
	{ value: 'Pacific/Auckland', label: 'Auckland' },
	{ value: 'UTC', label: 'UTC' },
];

// Initialize form when organization settings load
watch(
	organizationSettings,
	(settings) => {
		if (settings) {
			form.timezone = settings.timezone || '';
			form.defaultFromName = settings.defaultFromName || '';
			form.defaultFromEmail = settings.defaultFromEmail || '';
			isFormDirty.value = false;
		}
	},
	{ immediate: true }
);

// Initialize archive toggle from the feature flag (single source of truth)
watch(
	() => flags.value['campaigns.archive'],
	(enabled) => {
		form.archiveEnabled = enabled === true;
	},
	{ immediate: true }
);

// Initialize name from BetterAuth organization
watch(
	organization,
	(org) => {
		if (org) {
			form.name = org.name || '';
		}
	},
	{ immediate: true }
);

// Watch form changes
watch(
	form,
	() => {
		const orgName = organization.value?.name || '';
		const settings = organizationSettings.value;
		const archiveFlag = flags.value['campaigns.archive'] === true;
		const hasChanges =
			form.name !== orgName ||
			form.timezone !== (settings?.timezone || '') ||
			form.defaultFromName !== (settings?.defaultFromName || '') ||
			form.defaultFromEmail !== (settings?.defaultFromEmail || '') ||
			form.archiveEnabled !== archiveFlag;
		isFormDirty.value = hasChanges;
	},
	{ deep: true }
);

// Toast notification using global composable
const { showToast } = useToast();

// Validate form
const validateForm = (): boolean => {
	formErrors.name = '';
	formErrors.defaultFromEmail = '';

	let isValid = true;

	if (!form.name.trim()) {
		formErrors.name = 'Team name is required';
		isValid = false;
	}

	if (form.defaultFromEmail && !isValidEmail(form.defaultFromEmail)) {
		formErrors.defaultFromEmail = 'Please enter a valid email address';
		isValid = false;
	}

	return isValid;
};

// Save settings. Resolves to whether the save succeeded so the unsaved-changes
// guard can keep the user on the page (and keep their edits) when it fails.
const handleSave = async (): Promise<boolean> => {
	if (!hasActiveOrganization.value) return false;

	if (!validateForm()) return false;

	isSaving.value = true;

	// Update the organization settings (timezone, from name/email)
	const settingsResult = await updateOrganizationSettings({
		timezone: form.timezone || undefined,
		defaultFromName: form.defaultFromName.trim() || undefined,
		defaultFromEmail: form.defaultFromEmail.trim() || undefined,
	});
	if (settingsResult === undefined) {
		isSaving.value = false;
		return false;
	}

	// Archive default is a feature flag, not an instanceSettings column
	const archiveFlag = flags.value['campaigns.archive'] === true;
	if (form.archiveEnabled !== archiveFlag) {
		if (
			(await setFeatureFlag({ flag: 'campaigns.archive', value: form.archiveEnabled })) ===
			undefined
		) {
			isSaving.value = false;
			return false;
		}
	}

	// Also update the BetterAuth organization name if it exists and the name changed
	if (organization.value && form.name.trim() !== organization.value.name) {
		try {
			await updateOrganization({ name: form.name.trim() });
		} catch (orgError) {
			// Don't fail the whole operation if organization update fails
		}
	}

	isSaving.value = false;
	showToast('Settings saved successfully');
	isFormDirty.value = false;
	return true;
};

// Unsaved-changes guard: a sidebar click (or any in-app navigation) while the
// General form is dirty prompts to save/discard instead of silently dropping
// the edits. Reuses the shared composable + dialog (the same ones the email
// editor uses). `onSave` throws on failure so a failed save keeps the user here.
const {
	showDialog: showUnsavedDialog,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	setHasChanges,
} = useUnsavedChanges({
	onSave: async () => {
		if (!(await handleSave())) throw new Error('Save failed');
	},
});

watch(isFormDirty, (dirty) => setHasChanges(dirty), { immediate: true });
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">General</h1>
			<p class="mt-1 text-text-secondary">Workspace-wide identity and sending defaults</p>
		</div>

		<UiQueryBoundary
			:loading="isLoading && !organizationSettings"
			:error="organizationSettingsError"
		>
			<template #loading>
				<div class="flex items-center justify-center py-16">
					<div class="flex flex-col items-center gap-3">
						<UiSpinner />
						<p class="text-text-secondary text-sm">Loading settings...</p>
					</div>
				</div>
			</template>

			<!-- No Workspace State -->
			<UiCard v-if="!hasActiveOrganization">
				<UiEmptyState
					icon="lucide:settings"
					title="No workspace selected"
					description="Create or select a workspace to manage settings."
				/>
			</UiCard>

			<!-- Settings Content -->
			<div v-else class="space-y-8">
				<!-- General Settings Section -->
				<UiCard padding="none" overflow="hidden">
					<template #header>
						<div class="flex items-center gap-3">
							<UiIconBox icon="lucide:building-2" size="sm" variant="surface" rounded="lg" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">General</h2>
								<p class="text-sm text-text-secondary">Team settings and defaults</p>
							</div>
						</div>
					</template>

					<form class="p-6" @submit.prevent="handleSave">
						<div class="grid gap-6 max-w-2xl">
							<!-- Team Name -->
							<UiInput
								v-model="form.name"
								label="Team Name"
								placeholder="My Team"
								:error="formErrors.name"
								:disabled="isSaving"
								:required="true"
								help-text="This name will be displayed in your team's emails and dashboard."
							/>

							<!-- Timezone -->
							<UiSelect
								v-model="form.timezone"
								label="Timezone"
								:options="timezones"
								:disabled="isSaving"
							/>
							<p class="-mt-4 text-xs text-text-tertiary">
								Fallback timezone for send-time-optimized campaigns when a recipient's own timezone
								is unknown.
							</p>

							<!-- Divider -->
							<div class="border-t border-border-subtle pt-6 -mx-6 px-6">
								<h3 class="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
									<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
									Default Sender Information
								</h3>
								<p class="text-xs text-text-tertiary mb-4">
									These values are the default the app sends system mail from (verifications,
									password resets) and prefill new campaigns.
								</p>
								<NuxtLink
									to="/dashboard/admin/team/senders"
									class="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
								>
									<Icon name="lucide:at-sign" class="w-3.5 h-3.5" />
									Manage the addresses campaigns can send from
									<Icon name="lucide:arrow-right" class="w-3.5 h-3.5" />
								</NuxtLink>
							</div>

							<!-- Default From Name -->
							<UiInput
								v-model="form.defaultFromName"
								label="Default From Name"
								placeholder="e.g., Company Name"
								:disabled="isSaving"
								help-text="The sender name recipients will see in their inbox."
							/>

							<!-- Default From Email -->
							<div>
								<UiInput
									v-model="form.defaultFromEmail"
									type="email"
									label="Default From Email"
									placeholder="e.g., hello@company.com"
									:error="formErrors.defaultFromEmail"
									:disabled="isSaving"
									help-text="The email address your campaigns will be sent from."
								/>
								<!-- Non-blocking warning: domain is not verified for sending -->
								<p
									v-if="fromDomainWarning"
									class="mt-1.5 text-xs text-warning flex items-start gap-1.5"
								>
									<Icon name="lucide:alert-triangle" class="w-3.5 h-3.5 shrink-0 mt-px" />
									<span>
										{{ fromDomainWarning }}
										<NuxtLink
											to="/dashboard/admin/delivery/domains"
											class="underline hover:text-warning/80 whitespace-nowrap"
										>
											Set up a verified domain →
										</NuxtLink>
									</span>
								</p>
								<!-- Auto-suggest from verified domains -->
								<div
									v-if="(verifiedDomains?.length ?? 0) > 0"
									class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary"
								>
									<span>Verified:</span>
									<button
										v-for="d in verifiedDomains ?? []"
										:key="d._id"
										type="button"
										:disabled="isSaving"
										class="px-1.5 py-0.5 rounded bg-bg-surface border border-border-subtle hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
										@click="applyVerifiedDomain(d.domain)"
									>
										{{ d.domain }}
									</button>
								</div>
							</div>

							<!-- Campaign Archives Default -->
							<div class="flex items-center justify-between py-2">
								<div>
									<p class="text-sm font-medium text-text-primary">
										Enable campaign archives by default
									</p>
									<p class="text-xs text-text-tertiary mt-0.5">
										New campaigns will include a "View in browser" link and a public archive page.
									</p>
								</div>
								<UiSwitch
									v-model="form.archiveEnabled"
									:disabled="isSaving"
									label="Enable campaign archives by default"
								/>
							</div>
						</div>

						<!-- Save Button -->
						<div class="flex items-center justify-between pt-6 mt-6 border-t border-border-subtle">
							<p v-if="isFormDirty" class="text-sm text-warning flex items-center gap-2">
								<Icon name="lucide:alert-circle" class="w-4 h-4" />
								You have unsaved changes
							</p>
							<p v-else class="text-sm text-text-tertiary" />

							<UiButton type="submit" :loading="isSaving" :disabled="!isFormDirty">
								<template #iconLeft>
									<Icon v-if="!isSaving" name="lucide:check" class="w-4 h-4" />
								</template>
								{{ isSaving ? 'Saving...' : 'Save Changes' }}
							</UiButton>
						</div>
					</form>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<!-- Connected workspaces (desktop only) -->
		<div v-if="isDesktop" class="mt-8">
			<div class="mb-4">
				<h2 class="text-lg font-medium text-text-primary">Connected workspaces</h2>
				<p class="text-sm text-text-secondary mt-0.5">
					Switch between the Owlat workspaces you've connected on this device, or connect another.
				</p>
			</div>
			<SettingsConnectedWorkspaces />
		</div>

		<!-- Unsaved Changes Dialog -->
		<UnsavedChangesDialog
			:show="showUnsavedDialog"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>
	</div>
</template>
