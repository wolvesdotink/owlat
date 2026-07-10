<script setup lang="ts">
import { api } from '@owlat/api';
import { resolveFlags, type FeatureFlagState } from '@owlat/shared/featureFlags';

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

const { showToast } = useToast();

const { data: settings, isLoading: isLoadingSettings } = useConvexQuery(
	api.organizations.settings.get,
	{}
);
const { data: liveFlags } = useConvexQuery(api.organizations.featureFlags.getFeatureFlags, {});

const isMigrationMode = computed<boolean>(() => settings.value?.isMigrationMode ?? false);
const mailExternalEnabled = computed<boolean>(() => {
	const resolved = resolveFlags((liveFlags.value ?? {}) as FeatureFlagState);
	return resolved['mail.external'] === true;
});

const { run: updateSettings, isLoading: isSavingSettings } = useBackendOperation(
	api.organizations.settings.update,
	{ label: 'Update migration mode' }
);
const { run: setFeatureFlag, isLoading: isSavingFlag } = useBackendOperation(
	api.organizations.featureFlags.setFeatureFlag,
	{ label: 'Enable external mailbox import' }
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
	if (res === undefined) return; // failure already toasted by the operation module
	showToast(
		next
			? 'Migration mode on — new users will be offered a mail import at first login.'
			: 'Migration mode off — new users get a fresh-start welcome.'
	);
}

async function confirmAndEnable() {
	// Enable the import capability first so migration mode never promises an
	// import the instance cannot perform.
	const flagRes = await setFeatureFlag({ flag: 'mail.external', value: true });
	if (flagRes === undefined) {
		confirmEnableImport.value = false;
		return;
	}
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
					<h2 class="text-lg font-medium text-text-primary">Coming from another platform?</h2>
					<p class="text-sm text-text-secondary">Controls how new teammates are welcomed.</p>
				</div>
			</div>
		</template>

		<!-- Loading -->
		<div v-if="isLoadingSettings" class="flex items-center gap-3 py-2">
			<UiSpinner size="sm" />
			<span class="text-sm text-text-secondary">Loading setting…</span>
		</div>

		<div v-else class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<p class="text-sm text-text-primary">This team is moving from another email platform.</p>
				<p class="mt-1 text-sm text-text-secondary">
					New users will be offered a mail import at first login.
				</p>
				<p v-if="!canManage" class="mt-2 text-xs text-text-tertiary">
					Only owners and admins can change this.
				</p>
			</div>
			<UiToggle
				:model-value="isMigrationMode"
				:disabled="!canManage || isSaving"
				:label="isMigrationMode ? 'On' : 'Off'"
				@update:model-value="onToggle"
			/>
		</div>

		<UiConfirmationDialog
			:open="confirmEnableImport"
			title="Turn on mail import too?"
			description="Migration mode offers new users a mail import, which needs the “Connect external mailbox” feature. We'll turn that on now so the import actually works."
			confirm-text="Turn both on"
			:is-loading="isSaving"
			@update:open="(v: boolean) => !v && (confirmEnableImport = false)"
			@confirm="confirmAndEnable"
			@cancel="confirmEnableImport = false"
		/>
	</UiCard>
</template>
