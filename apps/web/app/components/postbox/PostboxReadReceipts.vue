<script setup lang="ts">
/**
 * The read receipts a message WE sent asked for, under its To line: who sent
 * one back and when, who has not, and why "not yet" is not "unread".
 */
import { formatDateTime } from '~/utils/formatters';
import { readReceiptView, type ReadReceiptRecord } from '~/utils/postboxReadReceipts';
import { MailCheckIcon, MailIcon } from '@coolicons/vue';

const props = defineProps<{
	receipt: ReadReceiptRecord;
	/** The message's recipients, in dispatch order. */
	recipients: string[];
}>();

const { t, locale } = useI18n();

const view = computed(() => readReceiptView(props.receipt, props.recipients));
</script>

<template>
	<section
		class="text-xs text-text-secondary"
		:aria-label="t('components.postbox.postboxReadReceipts.regionLabel')"
		data-testid="reader-read-receipts"
	>
		<p v-for="line in view.lines" :key="line.address" class="flex items-center gap-1.5">
			<MailCheckIcon class="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
			<span>{{ t(line.key, { address: line.address }) }}</span>
			<span class="text-text-tertiary tabular-nums">{{ formatDateTime(line.at, locale) }}</span>
		</p>
		<p v-if="view.waiting.length > 0" class="flex items-start gap-1.5">
			<MailIcon class="w-3.5 h-3.5 mt-px shrink-0 text-text-tertiary" />
			<span>
				{{
					view.waiting.length === 1
						? t('components.postbox.postboxReadReceipts.waitingOne', {
								address: view.waiting[0],
							})
						: t('components.postbox.postboxReadReceipts.waitingMany', {
								count: view.waiting.length,
							})
				}}
				<span class="text-text-tertiary">{{
					t('components.postbox.postboxReadReceipts.caveat')
				}}</span>
			</span>
		</p>
	</section>
</template>
