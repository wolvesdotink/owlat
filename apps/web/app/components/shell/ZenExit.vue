<script setup lang="ts">
import { isOverlayOpen, isZenChord, zenTakesEscape } from '~/utils/zenMode';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { useZenMode } from '~/composables/useZenMode';
import { useEscapeLayer } from '@owlat/ui/composables/useEscapeLayer';
import { ShrinkIcon } from '@coolicons/vue';

/**
 * Zen mode's keyboard and its one visible control. Mounted once by the
 * dashboard layout, in the header's place, in and out of Zen.
 *
 * - Cmd/Ctrl+Shift+F toggles Zen anywhere, unless a surface claimed the chord
 *   first (the email builder's own focus mode does, and calls preventDefault).
 * - Esc leaves Zen before it does anything on the page (utils/zenMode.ts), so
 *   one press is one action: the first Esc brings the app back, the next one
 *   closes the conversation.
 * - In Zen the header becomes one slim bar holding only "Exit Zen". It is part
 *   of the page flow, not floating, so it can never cover the page's own
 *   top-right controls.
 */
const props = defineProps<{
	/** Render the bar. Off where the page is chrome-less on its own terms. */
	showBar: boolean;
	/** The page owns Esc even in Zen (Answer mode, the editor's focus mode). */
	pageOwnsEscape: boolean;
}>();

const { t } = useI18n();
const { isZen, toggleZen, exitZen } = useZenMode();
const { announce } = useAnnounce();

watch(isZen, async (on) => {
	announce(on ? t('components.shell.zen.entered') : t('components.shell.zen.left'));
	if (!on) return;
	// Whatever had focus may have just been unmounted with the chrome.
	await nextTick();
	if (!document.activeElement || document.activeElement === document.body)
		document.getElementById('main-content')?.focus({ preventScroll: true });
});

// Zen is the base layer of the shared Escape stack: any dialog, menu or popover
// opened on top of it closes first, and the press reaches the page only once
// Zen has declined it (utils/zenMode.ts).
useEscapeLayer(
	() => isZen.value && !props.pageOwnsEscape,
	(event) => {
		if (!isZen.value) return false;
		const takes = zenTakesEscape({
			composing: event.isComposing,
			editable: isEditableTarget(event.target),
			overlayOpen: isOverlayOpen(),
			pageOwnsEscape: props.pageOwnsEscape,
		});
		if (!takes) return false;
		exitZen();
	},
	{ base: true }
);

// Bubble phase: a surface with its own Cmd/Ctrl+Shift+F wins the press.
function onKeydown(event: KeyboardEvent) {
	if (!isZenChord(event) || event.defaultPrevented) return;
	event.preventDefault();
	if (!event.repeat) toggleZen();
}

// oxlint-disable-next-line owlat/no-raw-keydown-listener -- global.zen, matched leniently and only when no surface claimed the chord first
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
	<div
		v-if="isZen && props.showBar"
		class="flex h-[var(--shell-chrome-h)] items-center justify-end px-3 pt-[env(safe-area-inset-top,0px)]"
	>
		<button
			type="button"
			data-testid="zen-exit"
			class="flex min-h-8 items-center gap-2 rounded-full border border-border-subtle bg-bg-elevated px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:min-h-11"
			@click="exitZen"
		>
			<ShrinkIcon class="size-3.5" />
			{{ t('components.shell.zen.exit') }}
			<kbd class="hidden font-mono text-2xs text-text-tertiary sm:inline">Esc</kbd>
		</button>
	</div>
</template>
