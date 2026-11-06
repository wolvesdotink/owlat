<script setup lang="ts">
/**
 * A sender's request for a read receipt (RFC 8098), on the message that
 * carries it: Send / Don't send while nobody answered, then one line saying
 * what was answered. A declined request keeps a Send, since a receipt can
 * still go out; a sent one cannot be taken back, so that line has no action.
 *
 * The person's "Read receipts" setting may have answered it on opening
 * (mail/readReceipts.ts); the line says so.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { MailCheckIcon } from '@coolicons/vue';
import type { PostboxReaderMessage } from '~/composables/postbox/postboxReaderMessage';

const props = defineProps<{
	message: Pick<PostboxReaderMessage, '_id' | 'fromAddress' | 'fromName' | 'receiptRequest'>;
}>();

const { t } = useI18n();

const respond = useBackendOperation(api.mail.readReceipts.respondToReceiptRequest, {
	label: () => t('components.postbox.postboxReceiptRequestBar.operation'),
});

const request = computed(() => props.message.receiptRequest);
const sender = computed(() => props.message.fromName || props.message.fromAddress);

const answeredKey = computed(() => {
	const r = request.value;
	if (!r?.answer) return null;
	const prefix = 'components.postbox.postboxReceiptRequestBar';
	if (r.answer === 'sent') return r.isAutomatic ? `${prefix}.sentAutomatic` : `${prefix}.sent`;
	return r.isAutomatic ? `${prefix}.declinedAutomatic` : `${prefix}.declined`;
});

function answer(choice: 'send' | 'decline') {
	void respond.run({ messageId: props.message._id as Id<'mailMessages'>, answer: choice });
}
</script>

<template>
	<section
		v-if="request"
		class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-text-secondary"
		:aria-label="t('components.postbox.postboxReceiptRequestBar.regionLabel')"
		data-testid="reader-receipt-request"
	>
		<MailCheckIcon class="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
		<template v-if="!answeredKey">
			<span>{{ t('components.postbox.postboxReceiptRequestBar.asked', { sender }) }}</span>
			<span class="flex items-center gap-1">
				<UiButton
					variant="outline"
					size="sm"
					:loading="respond.isLoading.value"
					data-testid="reader-receipt-request-send"
					@click="answer('send')"
				>
					{{ t('components.postbox.postboxReceiptRequestBar.send') }}
				</UiButton>
				<UiButton
					variant="ghost"
					size="sm"
					:disabled="respond.isLoading.value"
					data-testid="reader-receipt-request-decline"
					@click="answer('decline')"
				>
					{{ t('components.postbox.postboxReceiptRequestBar.decline') }}
				</UiButton>
			</span>
		</template>
		<template v-else>
			<span data-testid="reader-receipt-request-answer">{{ t(answeredKey, { sender }) }}</span>
			<UiButton
				v-if="request.answer === 'declined'"
				variant="ghost"
				size="sm"
				:loading="respond.isLoading.value"
				data-testid="reader-receipt-request-send"
				@click="answer('send')"
			>
				{{ t('components.postbox.postboxReceiptRequestBar.sendAnyway') }}
			</UiButton>
		</template>
	</section>
</template>
