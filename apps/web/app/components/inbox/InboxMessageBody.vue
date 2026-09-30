<script setup lang="ts">
import { api } from '@owlat/api';
import type { Doc } from '@owlat/api/dataModel';

/**
 * One team-inbox message's text in the thread view.
 *
 * A part too large to keep on its row is held in storage, and `getThread` can
 * only hand back its bounded `bodyExcerpt` — a query cannot read blob
 * contents. That happens to the text part, or, for a message with no text
 * (a large HTML newsletter), to the HTML. Either way the excerpt renders at
 * once, marked as the beginning of the message, and the full text replaces it
 * when `inbox.bodyText.getInboundMessageText` answers (the HTML as plain text
 * when there is no text part). If that fails the excerpt and its note stay: a
 * reader is never shown a cut message as whole.
 *
 * Every message whose text fit on its row renders exactly as before.
 */
export type InboxMessageText = Pick<
	Doc<'inboundMessages'>,
	'_id' | 'textBody' | 'bodyExcerpt' | 'textBodyStorageId' | 'htmlBodyStorageId'
>;

const props = defineProps<{ message: InboxMessageText }>();

const { t } = useI18n();

const fullText = ref<string | null>(null);
const isLoading = ref(false);

/** An inline text part with something in it — the only case that needs nothing more. */
const hasInlineText = computed(() => Boolean(props.message.textBody?.trim()));

/** The part a reader would see is in storage: the text, or the HTML standing in for none. */
const isReadableStored = computed(
	() =>
		!hasInlineText.value &&
		(props.message.textBodyStorageId !== undefined || props.message.htmlBodyStorageId !== undefined)
);

async function loadFullText(): Promise<void> {
	fullText.value = null;
	if (!isReadableStored.value) return;
	const messageId = props.message._id;
	isLoading.value = true;
	try {
		const text = await requireConvex().action(api.inbox.bodyText.getInboundMessageText, {
			messageId,
		});
		// A slow answer for a message the view has since moved off is dropped.
		if (messageId === props.message._id) fullText.value = text;
	} catch {
		// Keep the excerpt and its note.
	} finally {
		if (messageId === props.message._id) isLoading.value = false;
	}
}

onMounted(loadFullText);
watch(() => props.message._id, loadFullText);

const displayText = computed(() =>
	hasInlineText.value
		? (props.message.textBody ?? '')
		: (fullText.value ?? props.message.bodyExcerpt ?? props.message.textBody ?? '')
);
const isShowingExcerpt = computed(
	() => !hasInlineText.value && fullText.value === null && Boolean(props.message.bodyExcerpt)
);
</script>

<template>
	<div aria-live="polite" :aria-busy="isLoading">
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
