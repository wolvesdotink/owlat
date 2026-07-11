<script setup lang="ts">
import type { ThemeOption } from '~/composables/useAppTheme';
import { api } from '@owlat/api';
import { isValidEmail } from '~/utils/validation';
import { unverifiedFromDomainWarning } from '~/utils/fromEmailDomain';

useHead({ title: 'Settings — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

// Get BetterAuth organization for name updates
const { organization, update: updateOrganization } = useOrganization();

// Theme management
const { themePreference, setTheme } = useAppTheme();

const themeOptions: { value: ThemeOption; label: string; icon: string; description: string }[] = [
	{
		value: 'light',
		label: 'Light',
		icon: 'lucide:sun',
		description: 'Light background with dark text',
	},
	{
		value: 'dark',
		label: 'Dark',
		icon: 'lucide:moon',
		description: 'Dark background with light text',
	},
	{
		value: 'system',
		label: 'System',
		icon: 'lucide:monitor',
		description: 'Match your device settings',
	},
];

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

// Save settings
const handleSave = async () => {
	if (!hasActiveOrganization.value) return;

	if (!validateForm()) return;

	isSaving.value = true;

	// Update the organization settings (timezone, from name/email)
	const settingsResult = await updateOrganizationSettings({
		timezone: form.timezone || undefined,
		defaultFromName: form.defaultFromName.trim() || undefined,
		defaultFromEmail: form.defaultFromEmail.trim() || undefined,
	});
	if (settingsResult === undefined) {
		isSaving.value = false;
		return;
	}

	// Archive default is a feature flag, not an instanceSettings column
	const archiveFlag = flags.value['campaigns.archive'] === true;
	if (form.archiveEnabled !== archiveFlag) {
		if (
			(await setFeatureFlag({ flag: 'campaigns.archive', value: form.archiveEnabled })) ===
			undefined
		) {
			isSaving.value = false;
			return;
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
};

// Check platform-admin status to conditionally show the System card
const { data: isPlatformAdmin } = useConvexQuery(
	api.platformAdmin.platformAdmin.isPlatformAdmin,
	() => ({})
);

// Main settings sections
const settingsSections = computed(() => {
	const sections = [
		{
			name: 'Workspace',
			description: 'Members and email theme',
			href: '/dashboard/settings/workspace',
			icon: 'lucide:building-2',
		},
		{
			name: 'Delivery',
			description: 'Sending health, domains, providers, and webhooks — now its own section',
			href: '/dashboard/delivery',
			icon: 'lucide:truck',
		},
		{
			name: 'API Keys',
			description: 'Manage API keys that authenticate your send and API requests',
			href: '/dashboard/settings/api',
			icon: 'lucide:key',
		},
		{
			name: 'AI Provider',
			description: 'Choose the AI backend — a hosted key or a model you host yourself',
			href: '/dashboard/settings/ai-provider',
			icon: 'lucide:sparkles',
		},
		{
			name: 'Form Endpoints',
			description: 'Create embeddable signup forms for your website',
			href: '/dashboard/settings/forms',
			icon: 'lucide:file-text',
		},
		{
			name: 'Audit Log',
			description: 'Track team member actions and changes',
			href: '/dashboard/settings/audit',
			icon: 'lucide:clipboard-list',
		},
		{
			name: 'Contact Properties',
			description: 'Create and manage custom fields for contacts',
			href: '/dashboard/settings/properties',
			icon: 'lucide:tags',
		},
		{
			name: 'Account Management',
			description: 'Export your data or delete your account',
			href: '/dashboard/settings/account',
			icon: 'lucide:user-cog',
		},
	];

	// Platform-admin-only: Operator Console + System & Updates
	if (isPlatformAdmin.value === true) {
		sections.push({
			name: 'Operator Console',
			description:
				'Review held content, manage workspace sending status, and curate platform admins',
			href: '/dashboard/settings/operator',
			icon: 'lucide:shield-alert',
		});
		sections.push({
			name: 'System & Updates',
			description: 'Stack version, container health, and in-app updates',
			href: '/dashboard/settings/system',
			icon: 'lucide:cpu',
		});
		sections.push({
			name: 'Backups',
			description: 'Schedule daily backups, run one now, and find the restore command',
			href: '/dashboard/settings/backups',
			icon: 'lucide:database-backup',
		});
	}

	return sections;
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<h1 class="text-2xl font-semibold text-text-primary">Settings</h1>
			<p class="mt-1 text-text-secondary">Manage your account settings and integrations</p>
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
									to="/dashboard/settings/campaign-senders"
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
											to="/dashboard/delivery/domains"
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

				<!-- Appearance Section -->
				<UiCard padding="none" overflow="hidden">
					<template #header>
						<div class="flex items-center gap-3">
							<UiIconBox icon="lucide:sun" size="sm" variant="surface" rounded="lg" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">Appearance</h2>
								<p class="text-sm text-text-secondary">Customize how Owlat looks on your device</p>
							</div>
						</div>
					</template>

					<div class="p-6">
						<div class="max-w-2xl">
							<label class="label">Theme</label>
							<p class="text-xs text-text-tertiary mb-4">
								Select your preferred color scheme. Choose "System" to automatically match your
								device settings.
							</p>

							<!-- Theme Selector -->
							<div class="grid grid-cols-3 gap-3">
								<button
									v-for="option in themeOptions"
									:key="option.value"
									type="button"
									:class="[
										'flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-(--motion-moderate)',
										themePreference === option.value
											? 'border-brand bg-brand-subtle'
											: 'border-border-default bg-bg-surface hover:border-border-strong hover:bg-bg-surface-hover',
									]"
									@click="setTheme(option.value)"
								>
									<div
										:class="[
											'p-3 rounded-full transition-colors flex items-center justify-center',
											themePreference === option.value
												? 'bg-brand/20 text-brand'
												: 'bg-bg-overlay text-text-secondary',
										]"
									>
										<Icon :name="option.icon" class="w-5 h-5" />
									</div>
									<span
										:class="[
											'font-medium text-sm',
											themePreference === option.value ? 'text-brand' : 'text-text-primary',
										]"
									>
										{{ option.label }}
									</span>
									<span class="text-xs text-text-tertiary text-center">
										{{ option.description }}
									</span>
								</button>
							</div>
						</div>
					</div>
				</UiCard>

				<!-- Settings Sections -->
				<div>
					<h2 class="text-lg font-semibold text-text-primary mb-4">Settings</h2>
					<div class="grid gap-4">
						<NuxtLink
							v-for="section in settingsSections"
							:key="section.href"
							:to="section.href"
							class="group"
						>
							<UiCard hoverable>
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-4">
										<div
											class="p-3 rounded-lg bg-bg-surface group-hover:bg-brand/10 transition-colors flex items-center justify-center"
										>
											<Icon
												:name="section.icon"
												class="w-6 h-6 text-text-secondary group-hover:text-brand transition-colors"
											/>
										</div>
										<div>
											<h3 class="text-lg font-medium text-text-primary">{{ section.name }}</h3>
											<p class="text-sm text-text-secondary mt-0.5">{{ section.description }}</p>
										</div>
									</div>
									<Icon
										name="lucide:chevron-right"
										class="w-5 h-5 text-text-tertiary group-hover:text-brand transition-colors"
									/>
								</div>
							</UiCard>
						</NuxtLink>
					</div>

					<!-- Platform-admin note for non-admins: System & Updates and the
				     Operator Console are gated to the deployment's platform admin,
				     so they don't appear above for everyone else. -->
					<div
						v-if="isPlatformAdmin === false"
						class="mt-4 flex items-start gap-3 rounded-lg bg-bg-surface border border-border-subtle p-4"
					>
						<Icon name="lucide:shield" class="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
						<p class="text-sm text-text-secondary">
							System updates and operator tools (content review, sending status, and platform
							admins) are managed by this deployment's platform admin and aren't shown here.
							<a
								href="https://docs.owlat.app/developer/self-hosting-maintenance"
								target="_blank"
								rel="noopener"
								class="text-brand hover:underline whitespace-nowrap"
							>
								Learn more →
							</a>
						</p>
					</div>
				</div>
			</div>
		</UiQueryBoundary>
	</div>
</template>
