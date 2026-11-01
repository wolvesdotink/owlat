<script setup lang="ts">
/**
 * "Quote in reply": the one action over a passage selected in a message body,
 * placed by its host under the selection's last line and kept inside the
 * body's width.
 *
 * A press keeps the selection where it is (no focus moves on pointer-down),
 * so the passage it quotes is the one still highlighted. Enter and Space
 * activate it, the reply shortcut does too (the same key that quotes inside
 * the message), and Escape lets the selection go. The key hint comes from the
 * shortcut registry, so a remapped reply key shows as remapped.
 */
import type { FrameSelectionAnchor } from '~/composables/postbox/usePostboxFrameSelection';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import { resolvePostboxShortcut } from '~/utils/postboxShortcuts';
import { QuoteLeftIcon } from '@coolicons/vue';

const props = defineProps<{
	anchor: FrameSelectionAnchor;
	/** The width the pill must stay inside (the body's). */
	boundsWidth: number;
}>();

const emit = defineEmits<{
	quote: [];
	dismiss: [];
}>();

const { t } = useI18n();
const { labelFor, ariaFor } = useShortcutLabels();
const shortcut = computed(() => labelFor('postbox.reply'));

const el = ref<HTMLButtonElement | null>(null);
const width = ref(0);
watch(
	() => props.anchor,
	() => void nextTick(() => (width.value = el.value?.offsetWidth ?? 0)),
	{ immediate: true }
);

/** Below the last selected line, centred on its end, clamped to the body. */
const position = computed(() => {
	const centred = props.anchor.right - width.value / 2;
	const left = Math.max(0, Math.min(centred, props.boundsWidth - width.value));
	return { top: `${props.anchor.bottom + 6}px`, left: `${left}px` };
});

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		emit('dismiss');
		return;
	}
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (resolvePostboxShortcut(event.key) !== 'reply') return;
	// Claimed here, so the reader's own `r` (a reply to the latest message) stands down.
	event.preventDefault();
	emit('quote');
}

defineExpose({
	el,
	focus: () => el.value?.focus({ preventScroll: true }),
});
</script>

<template>
	<button
		ref="el"
		type="button"
		class="absolute z-20 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border-subtle bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-primary shadow-md hover:bg-bg-surface"
		:style="position"
		:aria-keyshortcuts="ariaFor('postbox.reply')"
		data-testid="quote-reply-pill"
		@pointerdown.prevent
		@mousedown.prevent
		@click="emit('quote')"
		@keydown="onKeydown"
	>
		<QuoteLeftIcon class="size-3.5 text-text-tertiary" aria-hidden="true" />
		{{ t('components.postbox.postboxQuoteReplyPill.action') }}
		<kbd
			v-if="shortcut"
			class="rounded border border-border-subtle px-1 font-sans text-[10px] text-text-tertiary"
			aria-hidden="true"
			>{{ shortcut }}</kbd
		>
	</button>
</template>
