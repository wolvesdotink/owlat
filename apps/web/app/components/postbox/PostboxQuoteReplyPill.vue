<script setup lang="ts">
/**
 * "Quote in reply" over a passage selected in a message body, and beside it
 * "Save as reply" when the host offers it, placed by the host under the
 * selection's last line and kept inside the body's width.
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

const props = defineProps<{
	anchor: FrameSelectionAnchor;
	/** The width the pill must stay inside (the body's). */
	boundsWidth: number;
	/** Offer "Save as reply" for the passage too. */
	canSave?: boolean;
}>();

const emit = defineEmits<{
	quote: [];
	save: [];
	dismiss: [];
}>();

const { t } = useI18n();
const { labelFor, ariaFor } = useShortcutLabels();
const shortcut = computed(() => labelFor('postbox.reply'));

// The whole group: a press anywhere in it keeps the selection.
const el = ref<HTMLElement | null>(null);
const quoteButton = ref<HTMLButtonElement | null>(null);
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

const pillClass =
	'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border-subtle bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-primary shadow-md hover:bg-bg-surface';

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
	focus: () => quoteButton.value?.focus({ preventScroll: true }),
});
</script>

<template>
	<div
		ref="el"
		class="absolute z-20 inline-flex items-center gap-1"
		:style="position"
		@pointerdown.prevent
		@mousedown.prevent
		@keydown="onKeydown"
	>
		<button
			ref="quoteButton"
			type="button"
			:class="pillClass"
			:aria-keyshortcuts="ariaFor('postbox.reply')"
			data-testid="quote-reply-pill"
			@click="emit('quote')"
		>
			<Icon name="lucide:quote" class="size-3.5 text-text-tertiary" aria-hidden="true" />
			{{ t('components.postbox.postboxQuoteReplyPill.action') }}
			<kbd
				v-if="shortcut"
				class="rounded border border-border-subtle px-1 font-sans text-[10px] text-text-tertiary"
				aria-hidden="true"
				>{{ shortcut }}</kbd
			>
		</button>
		<button
			v-if="canSave"
			type="button"
			:class="pillClass"
			data-testid="save-reply-pill"
			@click="emit('save')"
		>
			<Icon name="lucide:bookmark-plus" class="size-3.5 text-text-tertiary" aria-hidden="true" />
			{{ t('shared.savedReplies.saveCurrent') }}
		</button>
	</div>
</template>
