<script setup lang="ts">
import { api } from '@owlat/api';
import {
	OPERATING_MODES,
	OPERATING_MODE_KEYS,
	operatingModeFlags,
	type OperatingModeKey,
} from '@owlat/shared/operatingModes';
import type { CoreFeatureFlagKey, FeatureFlagState } from '@owlat/shared/featureFlags';
import { useFeatureCopy } from '~/composables/useFeatureCopy';
import { useProfileSync } from '~/composables/useProfileSync';

const { t } = useI18n();

const { flags } = useFeatureFlag();
const { flagKeyLabel } = useFeatureCopy();

// The mode whose flag set the workspace runs on right now, if any: a mixed set
// matches no mode, and then none is marked.
const currentMode = computed<OperatingModeKey | null>(() => {
	for (const key of OPERATING_MODE_KEYS) {
		const preset = operatingModeFlags(key);
		const matches = (Object.keys(preset) as CoreFeatureFlagKey[]).every(
			(flag) => (flags.value[flag] === true) === (preset[flag] === true)
		);
		if (matches) return key;
	}
	return null;
});
const selectedMode = ref<OperatingModeKey | null>(null);
const modesOpen = ref(false);
const { showToast } = useToast();
const { run: setAllFlags, isLoading: applyingMode } = useBackendOperation(
	api.workspaces.featureFlags.setAllFeatureFlags,
	{ label: () => t('components.settings.operatingModeCard.changeModeOperation') }
);

const desiredFlags = computed(() =>
	selectedMode.value ? operatingModeFlags(selectedMode.value) : null
);
const flagDiff = computed(() => {
	const desired = desiredFlags.value;
	if (!desired) return { enabled: [] as string[], disabled: [] as string[] };
	const enabled: string[] = [];
	const disabled: string[] = [];
	for (const key of Object.keys(desired) as CoreFeatureFlagKey[]) {
		const value = desired[key];
		const current = flags.value[key] === true;
		if (value && !current) enabled.push(flagKeyLabel(key));
		if (!value && current) disabled.push(flagKeyLabel(key));
	}
	return { enabled, disabled };
});

function chooseMode(key: OperatingModeKey) {
	selectedMode.value = key;
}

// A mode can start or stop background services, so it feeds the Features
// page's out-of-sync banner like every other flag control there.
const { trackFlagChange } = useProfileSync();

async function applyMode() {
	// Snapshots: Cancel or Escape can clear the selection while the save runs.
	const mode = selectedMode.value;
	const desired = desiredFlags.value;
	if (!mode || !desired) return;
	const before: FeatureFlagState = { ...flags.value };
	const result = await setAllFlags({ flags: desired });
	if (!result.ok) return;
	trackFlagChange(before, { ...before, ...desired });
	showToast(
		t('components.settings.operatingModeCard.modeChangedToast', {
			mode: t(OPERATING_MODES[mode].label),
		})
	);
	selectedMode.value = null;
	modesOpen.value = false;
}
</script>

<template>
	<UiCard>
		<h2 class="text-lg font-semibold text-text-primary">
			{{ t('components.settings.operatingModeCard.operatingMode') }}
		</h2>
		<p class="mt-1 mb-4 text-sm text-text-secondary max-w-2xl">
			{{ t('components.settings.operatingModeCard.operatingModeHelp') }}
		</p>
		<UiDisclosure
			v-model="modesOpen"
			controls="operating-mode-options"
			:label="t('components.settings.operatingModeCard.changeModeOperation')"
		>
			<div class="grid gap-3 md:grid-cols-2">
				<button
					v-for="key in OPERATING_MODE_KEYS"
					:key="key"
					type="button"
					class="text-left rounded-xl border p-4 hover:border-brand hover:bg-brand-subtle transition-colors"
					:class="key === currentMode ? 'border-brand' : 'border-border-subtle'"
					:aria-current="key === currentMode ? 'true' : undefined"
					@click="chooseMode(key)"
				>
					<span class="flex items-center gap-2">
						<span class="font-medium text-text-primary">{{ t(OPERATING_MODES[key].label) }}</span>
						<span
							v-if="key === currentMode"
							class="rounded-full bg-brand-subtle px-2 py-0.5 text-2xs font-medium text-brand"
							>{{ t('components.settings.operatingModeCard.currentMode') }}</span
						>
					</span>
					<span class="mt-1 block text-xs text-text-secondary">{{
						t(OPERATING_MODES[key].audience)
					}}</span>
				</button>
			</div>
		</UiDisclosure>

		<UiModal
			:open="selectedMode !== null"
			:title="t('components.settings.operatingModeCard.reviewTitle')"
			size="md"
			@update:open="
				(open) => {
					if (!open) selectedMode = null;
				}
			"
		>
			<div v-if="selectedMode" class="space-y-4">
				<div>
					<p class="font-medium text-text-primary">{{ t(OPERATING_MODES[selectedMode].label) }}</p>
					<p class="mt-1 text-sm text-text-secondary">
						{{ t(OPERATING_MODES[selectedMode].description) }}
					</p>
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					<div class="rounded-lg bg-success-subtle p-3">
						<p class="text-sm font-medium text-success">
							{{
								t('components.settings.operatingModeCard.enableCount', {
									count: flagDiff.enabled.length,
								})
							}}
						</p>
						<p class="mt-1 text-xs text-text-secondary break-words">
							{{
								flagDiff.enabled.join(', ') || t('components.settings.operatingModeCard.nothing')
							}}
						</p>
					</div>
					<div class="rounded-lg bg-warning-subtle p-3">
						<p class="text-sm font-medium text-warning">
							{{
								t('components.settings.operatingModeCard.disableCount', {
									count: flagDiff.disabled.length,
								})
							}}
						</p>
						<p class="mt-1 text-xs text-text-secondary break-words">
							{{
								flagDiff.disabled.join(', ') || t('components.settings.operatingModeCard.nothing')
							}}
						</p>
					</div>
				</div>
				<p class="text-xs text-text-tertiary">
					{{ t('components.settings.operatingModeCard.keepData') }}
				</p>
			</div>
			<template #footer>
				<UiButton variant="ghost" @click="selectedMode = null">{{ t('common.cancel') }}</UiButton>
				<UiButton :loading="applyingMode" @click="applyMode">{{
					t('components.settings.operatingModeCard.applyChanges')
				}}</UiButton>
			</template>
		</UiModal>
	</UiCard>
</template>
