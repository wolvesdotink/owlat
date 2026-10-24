<script setup lang="ts">
import { api } from '@owlat/api';
import type { Doc } from '@owlat/api/dataModel';
import { useReadingComfort } from '~/composables/useReadingComfort';
import { INBOX_TEXT_REM, READING_WIDTH_CSS } from '~/utils/readingComfort';

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

// The reader's text size and reading width (Preferences → Reading comfort),
// the same settings the Postbox reader applies to plain mail. The inline size
// overrides `text-sm`, whose unitless line-height then scales with it.
const { mailTypography } = useReadingComfort();
const textStyle = computed(() => ({
	fontSize: INBOX_TEXT_REM[mailTypography.value.textSize],
	maxWidth: READING_WIDTH_CSS[mailTypography.value.readingWidth],
}));

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
	// Reset for the message now shown: a fetch still in flight for the previous
	// one no longer owns either flag (its answer is dropped by id below).
	fullText.value = null;
	isLoading.value = false;
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
		<!-- The Postbox reader's measure (72ch by default), so a wide thread page
		     does not run a line of mail across the whole screen. -->
		<div
			class="text-text-secondary text-sm whitespace-pre-wrap"
			:style="textStyle"
			data-testid="inbox-message-body-text"
		>
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
