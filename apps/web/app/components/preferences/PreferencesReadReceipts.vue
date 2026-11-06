<script setup lang="ts">
/**
 * The read-receipt rows of the Reading card: how a sender's request for a
 * receipt is answered, and which of the person's From addresses start new
 * drafts with "Ask for a read receipt" on. Its own component because the card
 * and `usePostboxSettings` are both at the file-size cap.
 */
import { api } from '@owlat/api';
import { optimisticUpdateSettings } from '~/lib/mailOptimistic/settingsUpdater';
import {
	POSTBOX_READ_RECEIPT_REPLY_DEFAULT,
	POSTBOX_READ_RECEIPT_REPLY_OPTIONS,
	resolvePostboxReadReceiptReply,
	type PostboxReadReceiptReply,
} from '~/utils/postboxReadReceiptReply';
import PreferencesSettingRow from './PreferencesSettingRow.vue';

const { t } = useI18n();
const { data, isLoading } = useConvexQuery(api.mail.settings.get, () => ({}));
const { data: ownAddresses } = useConvexQuery(
	api.mail.readReceipts.listOwnFromAddresses,
	() => ({})
);
const updateOp = useBackendOperation(api.mail.settings.update, {
	label: 'Save Postbox settings',
	optimisticUpdate: optimisticUpdateSettings,
});

const reply = computed(() => resolvePostboxReadReceiptReply(data.value?.readReceiptReply));
const requestAddresses = computed<string[]>(() => data.value?.readReceiptRequestAddresses ?? []);
const isSaving = computed(() => updateOp.isLoading.value);

async function setReply(value: PostboxReadReceiptReply) {
	await updateOp.run({ readReceiptReply: value });
}

function onReplyChange(event: Event) {
	void setReply((event.target as HTMLSelectElement).value as PostboxReadReceiptReply);
}

async function setRequestedFor(address: string, isRequested: boolean) {
	const rest = requestAddresses.value.filter((a) => a !== address);
	await updateOp.run({ readReceiptRequestAddresses: isRequested ? [...rest, address] : rest });
}
</script>

<template>
	<PreferencesSettingRow
		control-id="postbox-read-receipt-reply"
		:label="t('components.preferences.preferencesReading.readReceiptReplyLabel')"
		:help="t('components.preferences.preferencesReading.readReceiptReplyHelp')"
		:changed="!isLoading && reply !== POSTBOX_READ_RECEIPT_REPLY_DEFAULT"
		:disabled="isSaving"
		data-testid="preferences-read-receipt-reply"
		@reset="setReply(POSTBOX_READ_RECEIPT_REPLY_DEFAULT)"
	>
		<select
			id="postbox-read-receipt-reply"
			class="input w-full sm:w-64 shrink-0"
			:value="reply"
			:disabled="isSaving"
			@change="onReplyChange"
		>
			<option
				v-for="option in POSTBOX_READ_RECEIPT_REPLY_OPTIONS"
				:key="option.value"
				:value="option.value"
			>
				{{ t(option.label) }}
			</option>
		</select>
	</PreferencesSettingRow>
	<PreferencesSettingRow
		v-if="ownAddresses && ownAddresses.length > 0"
		control-id="postbox-read-receipt-request-0"
		:label="t('components.preferences.preferencesReading.readReceiptRequestLabel')"
		:help="t('components.preferences.preferencesReading.readReceiptRequestHelp')"
		:changed="!isLoading && requestAddresses.length > 0"
		:disabled="isSaving"
		data-testid="preferences-read-receipt-request"
		@reset="updateOp.run({ readReceiptRequestAddresses: [] })"
	>
		<ul class="flex flex-col gap-1.5 shrink-0 sm:w-64">
			<li v-for="(address, i) in ownAddresses" :key="address">
				<label class="flex items-center gap-2 text-sm min-w-0">
					<input
						:id="`postbox-read-receipt-request-${i}`"
						type="checkbox"
						class="shrink-0"
						:checked="requestAddresses.includes(address)"
						:disabled="isSaving"
						@change="setRequestedFor(address, ($event.target as HTMLInputElement).checked)"
					/>
					<span class="truncate">{{ address }}</span>
				</label>
			</li>
		</ul>
	</PreferencesSettingRow>
</template>
