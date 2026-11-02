<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import PostboxThreadMenu from './PostboxThreadMenu.vue';

/**
 * The calm reader's header line (read on arrival §3): the subject,
 * Reply, Archive and ONE ⋯ menu (PostboxThreadMenu). Nothing else sits between
 * the subject and the strip: the follow-up chip, the team badge, the labels and
 * the cross-surface link moved into the strip's Details row.
 */
const props = defineProps<{
	subject?: string;
	messageCount: number;
	messageId: Id<'mailMessages'>;
	thread?: {
		_id: string;
		/** Muted conversation (mail/mute.ts) — new mail skips the inbox. */
		mutedAt?: number;
		/**
		 * Armed with "notify me when they reply" (mail/threadAlerts.ts) — a new
		 * message here toasts through quiet hours and the people-only scope.
		 */
		notifyOnReplyAt?: number;
		/** Just came back from snooze (mail/snooze.ts sweep); cleared on open. */
		snoozeReturnedAt?: number;
		/** In the Inbox's pinned band (mail/pins.ts). */
		pinnedAt?: number;
	} | null;
	/** Offer the explicit mark-read affordance (markReadPolicy 'manual', unread thread). */
	showMarkRead?: boolean;
	/** True while the mark-read mutation is in flight. */
	markingRead?: boolean;
	/** Offer "Why is this here?" (personal mailboxes; a team inbox has no arrival). */
	showWhyHere?: boolean;
	/** Offer "Ask about this thread" (the AI flag). */
	showAsk?: boolean;
	/** Offer "Full brief" (the brief holds anything, `briefHasContent`). */
	showFullBrief?: boolean;
}>();

const emit = defineEmits<{
	(e: 'toggle-mute'): void;
	(e: 'mark-read'): void;
	(e: 'toggle-alert'): void;
	(e: 'toggle-pin'): void;
	(e: 'reply'): void;
	(e: 'archive'): void;
	(e: 'snooze'): void;
	(e: 'ask'): void;
	(e: 'details'): void;
	(e: 'full-brief'): void;
	(e: 'why-here', anchor: HTMLElement | null): void;
}>();

const { t } = useI18n();
// Reply and Archive run the same reader action as their keys, so their
// tooltips and accessible shortcuts name the key as this person has it bound.
const { ariaFor } = useShortcutLabels();
const headerEl = ref<HTMLElement | null>(null);

// The "(2)" count must not wrap onto a line of its own, so the subject's last
// word and the count render as one unbreakable unit.
const subjectText = computed(
	() => props.subject || t('components.postbox.postboxThreadHeader.noSubject')
);
const subjectParts = computed(() => {
	const text = subjectText.value.trimEnd();
	const cut = text.search(/\S+$/);
	return { head: text.slice(0, Math.max(cut, 0)), tail: text.slice(Math.max(cut, 0)) };
});
</script>

<template>
	<!-- Focusable from script only: the sticky bar's "back to top" lands here,
	     since the bar it was clicked in hides as the header comes back. -->
	<header
		ref="headerEl"
		tabindex="-1"
		class="pbx-reader-header mb-3 outline-none"
		data-reader-chrome="header"
	>
		<div class="flex items-start gap-2">
			<!-- The verbs stay siblings of the header rather than its #actions: on a
			     phone they shrink to icons and keep to the subject's line, where the
			     header's actions row would drop them below it. -->
			<UiPageHeader class="flex-1 min-w-0">
				<template #title>
					<template v-if="messageCount > 1"
						>{{ subjectParts.head
						}}<span class="whitespace-nowrap"
							>{{ subjectParts.tail
							}}<span class="ml-1.5 text-base font-normal text-text-tertiary align-middle"
								>({{ messageCount }})</span
							></span
						></template
					>
					<template v-else>{{ subjectText }}</template>
				</template>
			</UiPageHeader>
			<!-- The thread's two verbs. On a phone they shrink to icons. -->
			<UiTooltip :text="t('postbox.reader.header.reply')">
				<template #shortcut><UiShortcut id="postbox.reply" /></template>
				<UiButton
					variant="ghost"
					size="sm"
					class="flex-shrink-0"
					:aria-label="t('postbox.reader.header.reply')"
					:aria-keyshortcuts="ariaFor('postbox.reply')"
					data-testid="thread-header-reply"
					@click="emit('reply')"
				>
					<Icon name="lucide:reply" class="w-4 h-4 sm:hidden" aria-hidden="true" />
					<span class="max-sm:sr-only">{{ t('postbox.reader.header.reply') }}</span>
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
					data-testid="thread-header-archive"
					@click="emit('archive')"
				>
					<Icon name="lucide:archive" class="w-4 h-4 sm:hidden" aria-hidden="true" />
					<span class="max-sm:sr-only">{{ t('postbox.reader.header.archive') }}</span>
				</UiButton>
			</UiTooltip>
			<!-- Host-owned thread actions (the reader's "Discuss" toggle). -->
			<slot name="actions" />
			<PostboxThreadMenu
				:thread="thread"
				:show-mark-read="showMarkRead"
				:marking-read="markingRead"
				:show-why-here="showWhyHere"
				:show-ask="showAsk"
				:show-full-brief="showFullBrief"
				@toggle-mute="emit('toggle-mute')"
				@mark-read="emit('mark-read')"
				@toggle-alert="emit('toggle-alert')"
				@toggle-pin="emit('toggle-pin')"
				@snooze="emit('snooze')"
				@ask="emit('ask')"
				@details="emit('details')"
				@full-brief="emit('full-brief')"
				@why-here="emit('why-here', headerEl)"
			/>
		</div>
	</header>
</template>
