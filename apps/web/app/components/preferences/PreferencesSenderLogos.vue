<script setup lang="ts">
/**
 * The "Show sender logos" row of the Reading card. Its own component because
 * the card and `usePostboxSettings` are both at the file-size cap.
 *
 * Off, the list and reader reads stop attaching logos for this person
 * (`mail/senderLogos/cache.ts`), so every sender is drawn with initials again.
 * Absent means on.
 */
import { api } from '@owlat/api';
import { optimisticUpdateSettings } from '~/lib/mailOptimistic/settingsUpdater';
import PreferencesSettingRow from './PreferencesSettingRow.vue';

const { t } = useI18n();
const { data, isLoading } = useConvexQuery(api.mail.settings.get, () => ({}));
const updateOp = useBackendOperation(api.mail.settings.update, {
	label: 'Save Postbox settings',
	optimisticUpdate: optimisticUpdateSettings,
});

const senderLogos = computed<boolean>(() => data.value?.isSenderLogosOn ?? true);
const isSaving = computed(() => updateOp.isLoading.value);

async function setSenderLogos(enabled: boolean) {
	await updateOp.run({ isSenderLogosOn: enabled });
}
</script>

<template>
	<PreferencesSettingRow
		layout="switch"
		control-id="postbox-sender-logos"
		:label="t('components.preferences.preferencesReading.senderLogosLabel')"
		:help="t('components.preferences.preferencesReading.senderLogosHelp')"
		:changed="!isLoading && !senderLogos"
		:disabled="isSaving"
		@reset="setSenderLogos(true)"
	>
		<UiSwitch
			id="postbox-sender-logos"
			:model-value="senderLogos"
			:disabled="isSaving"
			@update:model-value="setSenderLogos"
		/>
	</PreferencesSettingRow>
</template>
