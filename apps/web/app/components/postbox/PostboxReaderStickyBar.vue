<script setup lang="ts">
import { prefersReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import { useHeaderScrolledPast } from '~/composables/postbox/usePostboxReaderStickyBar';
import { findScrollParent } from '~/composables/postbox/usePostboxScrollHost';
import { ArchiveIcon, ReplyIcon } from '@coolicons/vue';

/**
 * The slim bar that takes over from the reader's header line once it scrolls
 * away: the subject and sender, Reply, Archive, and whatever the reader adds
 * (the list's Unsubscribe, the ⋯ menu). Clicking the subject goes back to the
 * top.
 *
 * The root is a zero-height sticky anchor and the bar hangs from it, so the
 * bar overlays the conversation instead of pushing it down when it appears.
 * It must come before the header in the article: the anchor only marks the
 * covered line once it sticks (see usePostboxReaderStickyBar). The host sets
 * `--pbx-reader-sticky-top` to the height of its own sticky bar above the
 * reader, and the article sets `--pbx-reader-bar-h`, which the message cards
 * also add to their scroll margin so a jump to a message lands below the bar.
 */
const props = defineProps<{
	subject?: string;
	sender?: string;
	/** The reader's header line; the bar shows once it has scrolled away. */
	header: HTMLElement | null;
}>();

const emit = defineEmits<{ reply: []; archive: [] }>();

const { t } = useI18n();
const { ariaFor } = useShortcutLabels();

const anchorEl = ref<HTMLElement | null>(null);
const headerEl = computed(() => props.header);
const shown = useHeaderScrolledPast(headerEl, anchorEl);

const subjectText = computed(
	() => props.subject || t('components.postbox.postboxThreadHeader.noSubject')
);

function backToTop() {
	const anchor = anchorEl.value;
	if (!anchor) return;
	findScrollParent(anchor).scrollTo({
		top: 0,
		behavior: prefersReducedMotion() ? 'auto' : 'smooth',
	});
	// The bar hides as the header returns, which would drop focus to <body>.
	props.header?.focus({ preventScroll: true });
}
</script>

<template>
	<div
		ref="anchorEl"
		class="sticky top-[var(--pbx-reader-sticky-top,0px)] z-10 h-0"
		data-reader-overlay="sticky-bar"
	>
		<Transition name="pbx-sticky-bar">
			<div
				v-show="shown"
				class="absolute inset-x-0 top-0 -mx-6 flex h-(--pbx-reader-bar-h) items-center gap-1 border-b border-border-subtle bg-bg-base px-6"
				data-testid="reader-sticky-bar"
			>
				<UiTooltip :text="t('postbox.reader.stickyBar.backToTop')">
					<button
						type="button"
						class="flex min-w-0 flex-1 flex-col rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
						:aria-label="t('postbox.reader.stickyBar.backToTopOf', { subject: subjectText })"
						data-testid="reader-sticky-bar-subject"
						@click="backToTop"
					>
						<span class="truncate text-sm font-medium leading-5 text-text-primary">{{
							subjectText
						}}</span>
						<span v-if="sender" class="truncate text-xs leading-4 text-text-tertiary">{{
							sender
						}}</span>
					</button>
				</UiTooltip>
				<!-- Host-owned, before the verbs (the list's Unsubscribe). -->
				<slot name="lead" />
				<UiTooltip :text="t('postbox.reader.header.reply')">
					<template #shortcut><UiShortcut id="postbox.reply" /></template>
					<UiButton
						variant="ghost"
						size="sm"
						class="flex-shrink-0"
						:aria-label="t('postbox.reader.header.reply')"
						:aria-keyshortcuts="ariaFor('postbox.reply')"
						data-testid="reader-sticky-bar-reply"
						@click="emit('reply')"
					>
						<ReplyIcon class="w-4 h-4" aria-hidden="true" />
					</UiButton>
				</UiTooltip>
				<UiTooltip :text="t('postbox.reader.header.archive')">
					<template #shortcut><UiShortcut id="postbox.archive" /></template>
					<UiButton
						variant="ghost"
						size="sm"
						class="flex-shrink-0"
						:aria-label="t('postbox.reader.header.archive')"
						:aria-keyshortcuts="ariaFor('postbox.archive')"
						data-testid="reader-sticky-bar-archive"
						@click="emit('archive')"
					>
						<ArchiveIcon class="w-4 h-4" aria-hidden="true" />
					</UiButton>
				</UiTooltip>
				<!-- Host-owned, after the verbs (the ⋯ menu). -->
				<slot />
			</div>
		</Transition>
	</div>
</template>
