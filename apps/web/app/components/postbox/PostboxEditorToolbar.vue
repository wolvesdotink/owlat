<script setup lang="ts">
/**
 * Formatting toolbar for {@link PostboxBasicEditor} (B / I / U, H1–H2, bullet &
 * ordered lists, blockquote, link).
 *
 * Pure presentation: it reflects the editor's current `activeMarks` and emits a
 * typed command per button. The parent owns the actual `useRichText` mutations
 * and re-focuses the contenteditable first (buttons keep `@mousedown.prevent`
 * so a click never steals the selection). Extracted from the editor SFC to keep
 * it under the file-size ratchet.
 */

import { computed } from 'vue';
import type { ActiveMarks } from '@owlat/ui/composables/useRichText';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import {
	BoldIcon,
	Heading1Icon,
	Heading2Icon,
	ItalicIcon,
	LinkIcon,
	ListOrderedIcon,
	ListUnorderedIcon,
	QuoteLeftIcon,
	UnderlineIcon,
} from '@coolicons/vue';

const { t } = useI18n();
// The editor's own Cmd/Ctrl-B/I/U/K (useRichText's handleFormatKeydown).
const { chordLabel, chordAria } = useShortcutLabels();

const props = withDefaults(
	defineProps<{
		activeMarks: ActiveMarks;
		/**
		 * `persistent` = the classic full-width bar bolted to the top of the editor
		 * (border + surface background). `floating` = the format section embedded in
		 * a floating bar that supplies its own chrome, so the toolbar stays neutral.
		 */
		variant?: 'persistent' | 'floating';
	}>(),
	{ variant: 'persistent' }
);

const containerClass = computed(() =>
	props.variant === 'floating'
		? 'flex items-center gap-0.5'
		: 'flex items-center gap-0.5 px-1 py-1 border-b border-border-subtle bg-bg-surface'
);

const emit = defineEmits<{
	(e: 'bold'): void;
	(e: 'italic'): void;
	(e: 'underline'): void;
	(e: 'heading', level: 1 | 2): void;
	(e: 'list', ordered: boolean): void;
	(e: 'blockquote'): void;
	(e: 'link'): void;
}>();
</script>

<template>
	<div :class="containerClass">
		<UiTooltip
			:text="t('components.postbox.postboxEditorToolbar.bold')"
			:shortcut="chordLabel('mod+b')"
		>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.bold }"
				:aria-label="t('components.postbox.postboxEditorToolbar.bold')"
				:aria-keyshortcuts="chordAria('mod+b')"
				@mousedown.prevent
				@click="emit('bold')"
			>
				<BoldIcon class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiTooltip
			:text="t('components.postbox.postboxEditorToolbar.italic')"
			:shortcut="chordLabel('mod+i')"
		>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.italic }"
				:aria-label="t('components.postbox.postboxEditorToolbar.italic')"
				:aria-keyshortcuts="chordAria('mod+i')"
				@mousedown.prevent
				@click="emit('italic')"
			>
				<ItalicIcon class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiTooltip
			:text="t('components.postbox.postboxEditorToolbar.underline')"
			:shortcut="chordLabel('mod+u')"
		>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.underline }"
				:aria-label="t('components.postbox.postboxEditorToolbar.underline')"
				:aria-keyshortcuts="chordAria('mod+u')"
				@mousedown.prevent
				@click="emit('underline')"
			>
				<UnderlineIcon class="w-4 h-4" />
			</button>
		</UiTooltip>
		<span class="w-px h-4 bg-border-subtle mx-1" />
		<UiTooltip :text="t('components.postbox.postboxEditorToolbar.heading1')">
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.h1 }"
				:aria-label="t('components.postbox.postboxEditorToolbar.heading1')"
				@mousedown.prevent
				@click="emit('heading', 1)"
			>
				<Heading1Icon class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiTooltip :text="t('components.postbox.postboxEditorToolbar.heading2')">
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.h2 }"
				:aria-label="t('components.postbox.postboxEditorToolbar.heading2')"
				@mousedown.prevent
				@click="emit('heading', 2)"
			>
				<Heading2Icon class="w-4 h-4" />
			</button>
		</UiTooltip>
		<span class="w-px h-4 bg-border-subtle mx-1" />
		<UiTooltip :text="t('components.postbox.postboxEditorToolbar.bulletList')">
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.ul }"
				:aria-label="t('components.postbox.postboxEditorToolbar.bulletList')"
				@mousedown.prevent
				@click="emit('list', false)"
			>
				<ListUnorderedIcon class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiTooltip :text="t('components.postbox.postboxEditorToolbar.orderedList')">
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.ol }"
				:aria-label="t('components.postbox.postboxEditorToolbar.orderedList')"
				@mousedown.prevent
				@click="emit('list', true)"
			>
				<ListOrderedIcon class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiTooltip :text="t('components.postbox.postboxEditorToolbar.blockquote')">
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.quote }"
				:aria-label="t('components.postbox.postboxEditorToolbar.blockquote')"
				@mousedown.prevent
				@click="emit('blockquote')"
			>
				<QuoteLeftIcon class="w-4 h-4" />
			</button>
		</UiTooltip>
		<span class="w-px h-4 bg-border-subtle mx-1" />
		<UiTooltip
			:text="t('components.postbox.postboxEditorToolbar.link')"
			:shortcut="chordLabel('mod+k')"
		>
			<button
				type="button"
				class="px-1.5 py-1 rounded text-sm hover:bg-bg-elevated"
				:class="{ 'bg-bg-elevated text-brand': activeMarks.link }"
				:aria-label="t('components.postbox.postboxEditorToolbar.link')"
				:aria-keyshortcuts="chordAria('mod+k')"
				@mousedown.prevent
				@click="emit('link')"
			>
				<LinkIcon class="w-4 h-4" />
			</button>
		</UiTooltip>
	</div>
</template>
