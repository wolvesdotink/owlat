<script setup lang="ts">
import { api } from '@owlat/api';
import ProfileSyncBanner from '~/components/settings/ProfileSyncBanner.vue';
import { useProfileSync } from '~/composables/useProfileSync';

/**
 * Instance-level "moving from another platform" switch (Settings → Team).
 *
 * Writes `instanceSettings.isMigrationMode` (admin-gated on the backend). When ON,
 * first-login onboarding offers new users a mail import; when OFF the welcome
 * flow is a pure fresh-start with no import surface.
 *
 * The import surface reads the `mail.external` feature flag, so turning migration
 * mode ON while that flag is OFF would promise an import the instance cannot
 * perform. We therefore confirm and enable `mail.external` alongside it.
 */

const props = defineProps<{
	/** Whether the current member may change organization settings (owner/admin). */
	canManage: boolean;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const { data: settings, isLoading: isLoadingSettings } = useConvexQuery(
	api.workspaces.settings.get,
	{}
);
const { data: liveFlags } = useConvexQuery(api.workspaces.featureFlags.getFeatureFlags, {});

const isMigrationMode = computed<boolean>(() => settings.value?.isMigrationMode ?? false);
// getFeatureFlags returns the already-resolved flag map, so read the effective
// value directly.
const mailExternalEnabled = computed<boolean>(() => liveFlags.value?.['mail.external'] === true);
const resolvedFlags = computed<Record<string, boolean>>(
	() => (liveFlags.value ?? {}) as Record<string, boolean>
);

// Enabling `mail.external` here changes the docker-profile set (the mail-sync
// worker), so this card shares the features page's out-of-sync banner (D4).
const { trackFlagChange } = useProfileSync();

const { run: updateSettings, isLoading: isSavingSettings } = useBackendOperation(
	api.workspaces.settings.update,
	{ label: () => t('components.settings.migrationModeCard.updateOperation') }
);
const { run: setFeatureFlag, isLoading: isSavingFlag } = useBackendOperation(
	api.workspaces.featureFlags.setFeatureFlag,
	{ label: () => t('components.settings.migrationModeCard.enableImportOperation') }
);

const isSaving = computed(() => isSavingSettings.value || isSavingFlag.value);

// When enabling migration mode requires also turning on `mail.external`, this
// holds the pending intent while the confirmation dialog is open.
const confirmEnableImport = ref(false);

async function onToggle(next: boolean) {
	if (!props.canManage || next === isMigrationMode.value) return;

	// Turning ON while the import capability is off: confirm before we enable both.
	if (next && !mailExternalEnabled.value) {
		confirmEnableImport.value = true;
		return;
	}

	await save(next);
}

async function save(next: boolean) {
	const res = await updateSettings({ isMigrationMode: next });
	if (!res.ok) return; // failure already toasted by the operation module
	showToast(
		next
			? t('components.settings.migrationModeCard.toastOn')
			: t('components.settings.migrationModeCard.toastOff')
	);
}

async function confirmAndEnable() {
	// Enable the import capability first so migration mode never promises an
	// import the instance cannot perform.
	const before = (liveFlags.value ?? {}) as Record<string, boolean>;
	const flagRes = await setFeatureFlag({ flag: 'mail.external', value: true });
	if (!flagRes.ok) {
		confirmEnableImport.value = false;
		return;
	}
	trackFlagChange(before, flagRes.result.flags);
	await save(true);
	confirmEnableImport.value = false;
}
</script>

<template>
	<UiCard>
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:import" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-medium text-text-primary">
						{{ t('components.settings.migrationModeCard.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('components.settings.migrationModeCard.subtitle') }}
					</p>
				</div>
			</div>
		</template>

		<!-- Loading -->
		<div v-if="isLoadingSettings" class="flex items-center gap-3 py-2">
			<UiSpinner size="sm" />
			<span class="text-sm text-text-secondary">
				{{ t('components.settings.migrationModeCard.loading') }}
			</span>
		</div>

		<div v-else class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<p class="text-sm text-text-primary">
					{{ t('components.settings.migrationModeCard.body') }}
				</p>
				<p class="mt-1 text-sm text-text-secondary">
					{{ t('components.settings.migrationModeCard.bodyDetail') }}
				</p>
				<p v-if="!canManage" class="mt-2 text-xs text-text-tertiary">
					{{ t('components.settings.migrationModeCard.adminsOnly') }}
				</p>
			</div>
			<UiToggle
				:model-value="isMigrationMode"
				:disabled="!canManage || isSaving"
				:label="
					isMigrationMode
						? t('components.settings.migrationModeCard.on')
						: t('components.settings.migrationModeCard.off')
				"
				@update:model-value="onToggle"
			/>
		</div>

		<!-- Enabling the import capability changes the docker-profile set, so
		     the shared out-of-sync banner surfaces here too (D4). -->
		<ProfileSyncBanner :flags="resolvedFlags" class="mt-4" />

		<UiConfirmationDialog
			:open="confirmEnableImport"
			:title="t('components.settings.migrationModeCard.confirmTitle')"
			:description="t('components.settings.migrationModeCard.confirmDescription')"
			:confirm-text="t('components.settings.migrationModeCard.confirmAction')"
			:is-loading="isSaving"
			@update:open="(v: boolean) => !v && (confirmEnableImport = false)"
			@confirm="confirmAndEnable"
			@cancel="confirmEnableImport = false"
		/>
	</UiCard>
</template>
