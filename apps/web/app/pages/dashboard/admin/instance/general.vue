<script setup lang="ts">
import { api } from '@owlat/api';
import { UnsavedChangesDialog } from '@owlat/email-builder';
import { instanceTimezoneSelectOptions } from '~/data/instanceTimezoneOptions';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { isValidEmail } from '@owlat/shared';
import { unverifiedFromDomainWarning } from '~/utils/fromEmailDomain';
import { useSettingsForm } from '~/composables/useSettingsForm';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.general.pageTitle') });

definePageMeta({
	layout: 'admin',
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
	label: () => t('dashboard.admin.instance.general.saveOperation'),
});
const { run: setFeatureFlag } = useBackendOperation(api.workspaces.featureFlags.setFeatureFlag, {
	label: () => t('dashboard.admin.instance.general.toggleArchivesOperation'),
});

// Feature flag state — archive default lives on `campaigns.archive`, not on instanceSettings
const { flags, isEnabled: isFeatureEnabled } = useFeatureFlag();

// Mail search only means something where mail is stored: a hosted postbox or a
// connected mailbox. Same gate the settings registry uses for mail settings.
const hasMail = computed(() => isFeatureEnabled('postbox') || isFeatureEnabled('mail.external'));

type GeneralForm = {
	name: string;
	timezone: string;
	defaultFromName: string;
	defaultFromEmail: string;
	archiveEnabled: boolean;
};

const DEFAULTS: GeneralForm = {
	name: '',
	timezone: '',
	defaultFromName: '',
	defaultFromEmail: '',
	archiveEnabled: false,
};

// BetterAuth refreshes the active organization after its own round trip, so a
// name just saved stands in for it until that refresh lands.
const savedName = ref<string | null>(null);
watch(
	() => organization.value?.name,
	() => {
		savedName.value = null;
	}
);

// The form draws on three stores: the settings row, the BetterAuth organization
// (the name) and the `campaigns.archive` feature flag (the archive default,
// which is not an instanceSettings column).
const stored = computed(() =>
	organizationSettings.value === undefined
		? undefined
		: {
				settings: organizationSettings.value,
				name: savedName.value ?? organization.value?.name ?? '',
				archiveEnabled: flags.value['campaigns.archive'] === true,
			}
);

const formErrors = reactive({
	name: '',
	defaultFromEmail: '',
});

// Toast notification using global composable
const { showToast } = useToast();

// Validate form
const validateForm = (draft: GeneralForm): boolean => {
	formErrors.name = '';
	formErrors.defaultFromEmail = '';

	let isValid = true;

	if (!draft.name.trim()) {
		formErrors.name = t('dashboard.admin.instance.general.errors.nameRequired');
		isValid = false;
	}

	if (draft.defaultFromEmail && !isValidEmail(draft.defaultFromEmail)) {
		formErrors.defaultFromEmail = t('dashboard.admin.instance.general.errors.emailInvalid');
		isValid = false;
	}

	return isValid;
};

// Three writes, in order: the settings row, the archive flag if it changed,
// then the organization name.
async function saveGeneral(draft: GeneralForm): Promise<boolean> {
	if (!hasActiveOrganization.value) return false;

	const settingsResult = await updateOrganizationSettings({
		timezone: draft.timezone || undefined,
		defaultFromName: draft.defaultFromName.trim() || undefined,
		defaultFromEmail: draft.defaultFromEmail.trim() || undefined,
	});
	if (!settingsResult.ok) return false;

	const archiveFlag = flags.value['campaigns.archive'] === true;
	if (draft.archiveEnabled !== archiveFlag) {
		if (!(await setFeatureFlag({ flag: 'campaigns.archive', value: draft.archiveEnabled })).ok) {
			return false;
		}
	}

	// Also update the BetterAuth organization name if it exists and the name changed
	const name = draft.name.trim();
	if (organization.value && name !== organization.value.name) {
		try {
			await updateOrganization({ name });
			savedName.value = name;
		} catch {
			// Don't fail the whole operation if organization update fails
		}
	}

	showToast(t('dashboard.admin.instance.general.savedToast'));
	return true;
}

const {
	form,
	isDirty: isFormDirty,
	isSaving,
	handleSave,
	unsavedDialog,
} = useSettingsForm({
	source: stored,
	defaults: DEFAULTS,
	project: (row) => ({
		name: row.name,
		timezone: row.settings?.timezone || '',
		defaultFromName: row.settings?.defaultFromName || '',
		defaultFromEmail: row.settings?.defaultFromEmail || '',
		archiveEnabled: row.archiveEnabled,
	}),
	validate: validateForm,
	save: saveGeneral,
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

// Common timezones for dropdown — a computed so the labels follow the active
// locale rather than the one that happened to be active at setup. The catalog
// itself lives in ~/data/instanceTimezoneOptions.
const timezones = computed(() => instanceTimezoneSelectOptions(t));
</script>

<template>
	<div>
		<UiPageHeader
			:title="t('dashboard.admin.instance.general.title')"
			:description="t('dashboard.admin.instance.general.subtitle')"
			class="mb-6"
		/>

		<UiQueryBoundary
			:loading="isLoading && !organizationSettings"
			:error="organizationSettingsError"
		>
			<template #loading>
				<DashboardDetailSkeleton
					:label="t('dashboard.admin.instance.general.loading')"
					:header="false"
					body="cards"
					:delay="false"
				/>
			</template>

			<!-- No Workspace State -->
			<UiCard v-if="!hasActiveOrganization">
				<UiEmptyState
					icon="lucide:settings"
					:title="t('dashboard.admin.instance.general.noWorkspaceTitle')"
					:description="t('dashboard.admin.instance.general.noWorkspaceBody')"
				/>
			</UiCard>

			<!-- Settings Content -->
			<div v-else class="space-y-8">
				<!-- General settings. No card header: the page h1 immediately above
				     already says "General" with its own subtitle, and a second
				     "General / Team settings and defaults" ~100px below it was the same
				     word twice. Straight into the fields, like Features and Webhooks. -->
				<UiCard padding="none" overflow="hidden">
					<form class="p-6" @submit.prevent="handleSave">
						<!-- No inner cap: the shell's reading width already bounds the
						     card, and a narrower grid left the section divider and the
						     archive switch short of the Save row's edge. -->
						<div class="grid gap-6">
							<!-- Team Name -->
							<UiInput
								v-model="form.name"
								:label="t('dashboard.admin.instance.general.teamName')"
								:placeholder="t('dashboard.admin.instance.general.teamNamePlaceholder')"
								:error="formErrors.name"
								:disabled="isSaving"
								:required="true"
								:help-text="t('dashboard.admin.instance.general.teamNameHelp')"
							/>

							<!-- Timezone -->
							<UiSelect
								v-model="form.timezone"
								:label="t('dashboard.admin.instance.general.timezone')"
								:options="timezones"
								:disabled="isSaving"
							/>
							<p class="-mt-4 text-xs text-text-tertiary">
								{{ t('dashboard.admin.instance.general.timezoneHelp') }}
							</p>

							<!-- Divider -->
							<div class="border-t border-border-subtle pt-6 -mx-6 px-6">
								<h3 class="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
									<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
									{{ t('dashboard.admin.instance.general.senderSection') }}
								</h3>
								<p class="text-xs text-text-tertiary mb-4">
									{{ t('dashboard.admin.instance.general.senderSectionHelp') }}
								</p>
								<NuxtLink
									to="/dashboard/admin/team/senders"
									class="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
								>
									<Icon name="lucide:at-sign" class="w-3.5 h-3.5" />
									{{ t('dashboard.admin.instance.general.manageSenders') }}
									<Icon name="lucide:arrow-right" class="w-3.5 h-3.5" />
								</NuxtLink>
							</div>

							<!-- Default From Name -->
							<UiInput
								v-model="form.defaultFromName"
								:label="t('dashboard.admin.instance.general.fromName')"
								:placeholder="t('dashboard.admin.instance.general.fromNamePlaceholder')"
								:disabled="isSaving"
								:help-text="t('dashboard.admin.instance.general.fromNameHelp')"
							/>

							<!-- Default From Email -->
							<div>
								<UiInput
									v-model="form.defaultFromEmail"
									type="email"
									:label="t('dashboard.admin.instance.general.fromEmail')"
									:placeholder="t('dashboard.admin.instance.general.fromEmailPlaceholder')"
									:error="formErrors.defaultFromEmail"
									:disabled="isSaving"
									:help-text="t('dashboard.admin.instance.general.fromEmailHelp')"
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
											{{ t('dashboard.admin.instance.general.setUpVerifiedDomain') }} →
										</NuxtLink>
									</span>
								</p>
								<!-- Auto-suggest from verified domains -->
								<div
									v-if="(verifiedDomains?.length ?? 0) > 0"
									class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary"
								>
									<span>{{ t('dashboard.admin.instance.general.verifiedLabel') }}</span>
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
							<div class="flex items-center justify-between gap-4 py-2">
								<div class="min-w-0">
									<p class="text-sm font-medium text-text-primary">
										{{ t('dashboard.admin.instance.general.archives') }}
									</p>
									<p class="text-xs text-text-tertiary mt-0.5">
										{{ t('dashboard.admin.instance.general.archivesHelp') }}
									</p>
								</div>
								<UiSwitch
									v-model="form.archiveEnabled"
									:disabled="isSaving"
									:label="t('dashboard.admin.instance.general.archives')"
								/>
							</div>
						</div>

						<!-- Save Button -->
						<div class="flex items-center justify-between pt-6 mt-6 border-t border-border-subtle">
							<p v-if="isFormDirty" class="text-sm text-warning flex items-center gap-2">
								<Icon name="lucide:alert-circle" class="w-4 h-4" />
								{{ t('dashboard.admin.instance.general.unsavedChanges') }}
							</p>
							<p v-else class="text-sm text-text-tertiary" />

							<UiButton type="submit" :loading="isSaving" :disabled="!isFormDirty">
								<template #iconLeft>
									<Icon v-if="!isSaving" name="lucide:check" class="w-4 h-4" />
								</template>
								{{
									isSaving
										? t('dashboard.admin.instance.general.saving')
										: t('dashboard.admin.instance.general.saveChanges')
								}}
							</UiButton>
						</div>
					</form>
				</UiCard>

				<!-- The workspace logo on the public pages (#810). Its own card
				     because picking a file applies it, outside the Save button. -->
				<SettingsWorkspaceLogoCard />
			</div>
		</UiQueryBoundary>

		<!-- Connected workspaces (desktop only) -->
		<div v-if="isDesktop" class="mt-8">
			<div class="mb-4">
				<h2 class="text-lg font-medium text-text-primary">
					{{ t('dashboard.admin.instance.general.connectedWorkspaces') }}
				</h2>
				<p class="text-sm text-text-secondary mt-0.5">
					{{ t('dashboard.admin.instance.general.connectedWorkspacesHelp') }}
				</p>
			</div>
			<SettingsConnectedWorkspaces />
		</div>

		<!-- How long received mail keeps its files. Its own card because it saves
		     on change rather than through this page's Save button. -->
		<div class="mt-8">
			<SettingsInboundRetentionCard />
		</div>

		<!-- Mail search: how much of each message search can reach. It used to
		     sit on the Sealed mail page; people looking for why search misses
		     things look here, and the search page's limit notice links here. -->
		<div
			v-if="hasActiveOrganization && hasMail"
			id="mail-search"
			class="mt-8 scroll-mt-6"
			data-testid="general-mail-search"
		>
			<SettingsBodySearchIndexCard />
		</div>

		<!-- Unsaved Changes Dialog -->
		<UnsavedChangesDialog
			:show="unsavedDialog.showDialog"
			:saving="unsavedDialog.isSavingBeforeLeave"
			@close="unsavedDialog.cancelNavigation"
			@discard="unsavedDialog.confirmDiscard"
			@save="unsavedDialog.confirmSave"
		/>

		<!-- ── Moved here from the Team page (#795) ───────────────────────────
		     Workspace-wide switches that are not about who is on the team. Both
		     save on their own, outside this page's Save button. -->

		<!-- Import on first login: offer new users a mail import. Everyone who
		     reaches this page is an owner or admin, so they may change it. -->
		<div class="mt-8">
			<SettingsMigrationModeCard
				id="import-on-first-login"
				class="scroll-mt-6"
				:can-manage="true"
			/>
		</div>

		<!-- Danger zone: delete the workspace (owner only, typed confirmation). -->
		<div class="mt-8">
			<SettingsWorkspaceDangerZone />
		</div>
	</div>
</template>
