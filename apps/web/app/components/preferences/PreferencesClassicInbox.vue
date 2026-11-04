<script setup lang="ts">
/**
 * The "Classic inbox" row of the Reading card: Priority and All mail instead
 * of the People view. Its own component because the card and
 * `usePostboxSettings` are both at the file-size cap. Off by default; on,
 * the inbox opens on the classic view the person used last.
 */
import PreferencesSettingRow from './PreferencesSettingRow.vue';

const { t } = useI18n();
const { isClassicInbox, isLoading, setClassicInbox } = usePostboxClassicInbox();
const isSaving = ref(false);

async function setClassic(isOn: boolean) {
	isSaving.value = true;
	try {
		await setClassicInbox(isOn);
	} finally {
		isSaving.value = false;
	}
}
</script>

<template>
	<PreferencesSettingRow
		first
		layout="switch"
		control-id="postbox-classic-inbox"
		:label="t('components.preferences.preferencesReading.classicInboxLabel')"
		:help="t('components.preferences.preferencesReading.classicInboxHelp')"
		:changed="!isLoading && isClassicInbox"
		:disabled="isSaving"
		@reset="setClassic(false)"
	>
		<UiSwitch
			id="postbox-classic-inbox"
			:model-value="isClassicInbox"
			:disabled="isSaving"
			@update:model-value="setClassic"
		/>
	</PreferencesSettingRow>
</template>
