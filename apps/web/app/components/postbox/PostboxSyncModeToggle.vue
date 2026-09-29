<script setup lang="ts">
/**
 * Two-way sync on or off for a connected external mailbox
 * (`externalMailAccounts.syncMode`).
 *
 * On (the default): moves, read state, stars and deletions travel both ways,
 * and the provider's own folders appear in Owlat. Off: only new mail comes in,
 * for someone who wants to manage the mailbox in Owlat and leave the provider
 * alone. The personal card and the team inbox card both render this; a team
 * inbox passes its `mailboxId`.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mode: 'full' | 'incoming';
	/** The team inbox this row belongs to; omitted for the caller's own mailbox. */
	mailboxId?: Id<'mailboxes'>;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const switchId = useId();
const saveError = ref<string | null>(null);
const label = () => t('components.postbox.postboxSyncModeToggle.changeOperation');
const setPersonal = useBackendOperation(api.mail.external.syncMode.setSyncMode, {
	label,
	inlineTarget: saveError,
});
const setShared = useBackendOperation(api.mail.external.syncMode.setSharedSyncMode, {
	label,
	inlineTarget: saveError,
});
const isSaving = computed(() => setPersonal.isLoading.value || setShared.isLoading.value);
const isTwoWay = computed(() => props.mode === 'full');

async function setTwoWay(on: boolean) {
	const mode = on ? 'full' : 'incoming';
	if (mode === props.mode) return;
	saveError.value = null;
	const result = props.mailboxId
		? await setShared.run({ mailboxId: props.mailboxId, mode })
		: await setPersonal.run({ mode });
	if (result.ok) {
		showToast(
			t(`components.postbox.postboxSyncModeToggle.${on ? 'toastOn' : 'toastOff'}`),
			'success'
		);
	}
}
</script>

<template>
	<div class="flex items-start justify-between gap-4" data-testid="sync-mode-toggle">
		<div class="min-w-0">
			<label :for="switchId" class="font-medium text-sm block">
				{{ t('components.postbox.postboxSyncModeToggle.label') }}
			</label>
			<p class="text-xs text-text-tertiary mt-0.5">
				{{
					isTwoWay
						? t('components.postbox.postboxSyncModeToggle.helpOn')
						: t('components.postbox.postboxSyncModeToggle.helpOff')
				}}
			</p>
			<p v-if="saveError" class="text-xs text-error mt-1" role="alert">{{ saveError }}</p>
		</div>
		<UiSwitch
			:id="switchId"
			:model-value="isTwoWay"
			:disabled="isSaving"
			@update:model-value="setTwoWay"
		/>
	</div>
</template>
