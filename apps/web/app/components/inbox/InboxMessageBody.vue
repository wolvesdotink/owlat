<script setup lang="ts">
import { api } from '@owlat/api';
import type { Doc } from '@owlat/api/dataModel';

/**
 * One team-inbox message's text in the thread view.
 *
 * A text part too large to keep on its row is held in storage
 * (`textBodyStorageId`), and `getThread` can only hand back its bounded
 * `bodyExcerpt` — a query cannot read blob contents. So the excerpt renders at
 * once, marked as the beginning of the message, and the full text replaces it
 * when `inbox.bodyText.getInboundMessageText` answers. If that fails the
 * excerpt and its note stay: a reader is never shown a cut message as whole.
 *
 * Every message whose text fit on its row renders exactly as before.
 */
export type InboxMessageText = Pick<
	Doc<'inboundMessages'>,
	'_id' | 'textBody' | 'bodyExcerpt' | 'textBodyStorageId'
>;

const props = defineProps<{ message: InboxMessageText }>();

const { t } = useI18n();

const fullText = ref<string | null>(null);

const isTextStored = computed(
	() => props.message.textBody === undefined && props.message.textBodyStorageId !== undefined
);

async function loadFullText(): Promise<void> {
	fullText.value = null;
	if (!isTextStored.value) return;
	const messageId = props.message._id;
	try {
		const text = await requireConvex().action(api.inbox.bodyText.getInboundMessageText, {
			messageId,
		});
		// A slow answer for a message the view has since moved off is dropped.
		if (messageId === props.message._id) fullText.value = text;
	} catch {
		// Keep the excerpt and its note.
	}
}

onMounted(loadFullText);
watch(() => props.message._id, loadFullText);

const displayText = computed(
	() => props.message.textBody ?? fullText.value ?? props.message.bodyExcerpt ?? ''
);
const isShowingExcerpt = computed(() => isTextStored.value && fullText.value === null);
</script>

<template>
	<div>
		<div class="text-text-secondary text-sm whitespace-pre-wrap">
			{{ displayText || t('dashboard.inbox.detail.noTextContent') }}
		</div>
		<p
			v-if="isShowingExcerpt"
			class="mt-2 text-xs text-text-tertiary"
			data-testid="inbox-message-body-excerpt"
		>
			{{ t('dashboard.inbox.detail.bodyExcerptNotice') }}
		</p>
	</div>
</template>
