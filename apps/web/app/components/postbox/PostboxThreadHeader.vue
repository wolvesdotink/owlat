<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ListUnsubscribeTarget } from '@owlat/shared/listUnsubscribe';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import PostboxThreadMenu from './PostboxThreadMenu.vue';
import { ArchiveIcon, CheckIcon, PencilIcon, ReplyIcon } from '@coolicons/vue';
import { POSTBOX_TOPIC_HEADING } from '~/utils/postboxPeople';

/**
 * The calm reader's header line (read on arrival §3): the subject,
 * Reply, Archive and ONE ⋯ menu (PostboxThreadMenu). Nothing else sits between
 * the subject and the strip: the follow-up chip, the team badge, the labels and
 * the cross-surface link moved into the strip's Details row.
 *
 * It also renders the sticky bar that stands in for this line once it scrolls
 * away (PostboxReaderStickyBar), as the sibling before the <header>: the bar's
 * anchor has to be a direct child of the article, ahead of the line it
 * watches. Both carry the same verbs and the same ⋯ menu.
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
	/** The conversation, oldest first: the sticky bar's sender and Unsubscribe. */
	messages?: ReadonlyArray<{
		_id: string;
		fromAddress: string;
		fromName?: string | null;
		unsubscribe?: ListUnsubscribeTarget;
	}>;
	mailboxId?: string;
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
const stickyBarRef = ref<{ $el: HTMLElement } | null>(null);

// The ⋯ menu's state and verbs, the same here and in the sticky bar.
const menuProps = computed(() => ({
	thread: props.thread,
	showMarkRead: props.showMarkRead,
	markingRead: props.markingRead,
	showWhyHere: props.showWhyHere,
	showAsk: props.showAsk,
	showFullBrief: props.showFullBrief,
}));
const menuOn = {
	'toggle-mute': () => emit('toggle-mute'),
	'mark-read': () => emit('mark-read'),
	'toggle-alert': () => emit('toggle-alert'),
	'toggle-pin': () => emit('toggle-pin'),
	snooze: () => emit('snooze'),
	ask: () => emit('ask'),
	details: () => emit('details'),
	'full-brief': () => emit('full-brief'),
};

// The bar names the latest sender (whom Reply answers) and offers the newest
// list unsubscribe in the conversation.
const latestSender = computed(() => {
	const latest = props.messages?.at(-1);
	return latest ? latest.fromName || latest.fromAddress : undefined;
});
const listMessage = computed(() => props.messages?.findLast((m) => !!m.unsubscribe));

// Opened from the People view, the conversation is headed by its topic name,
// with the subject it was written under as the line below.
const topicHeading = inject(POSTBOX_TOPIC_HEADING, null);
const heading = computed(() => topicHeading?.value ?? null);
// The topic name is edited where it is read.
const isRenaming = ref(false);
const renameDraft = ref('');
const renameInput = ref<HTMLInputElement | null>(null);
async function startRename() {
	if (!heading.value) return;
	renameDraft.value = heading.value.title;
	isRenaming.value = true;
	await nextTick();
	renameInput.value?.select();
}
async function saveRename() {
	if (!isRenaming.value || !heading.value) return;
	isRenaming.value = false;
	const next = renameDraft.value.trim();
	if (next && next !== heading.value.title) await heading.value.rename(next);
}
async function resetName() {
	isRenaming.value = false;
	await heading.value?.reset();
}
const subjectText = computed(
	() =>
		topicHeading?.value?.title ||
		props.subject ||
		t('components.postbox.postboxThreadHeader.noSubject')
);
// The "(2)" count must not wrap onto a line of its own, so the subject's last
// word and the count render as one unbreakable unit.
const subjectParts = computed(() => {
	const text = subjectText.value.trimEnd();
	const cut = text.search(/\S+$/);
	return { head: text.slice(0, Math.max(cut, 0)), tail: text.slice(Math.max(cut, 0)) };
});
</script>

<template>
	<!-- Hidden until this line scrolls away; it overlays the conversation, so it
	     adds nothing to the page above the mail. -->
	<PostboxReaderStickyBar
		ref="stickyBarRef"
		:subject="subject"
		:sender="latestSender"
		:header="headerEl"
		@reply="emit('reply')"
		@archive="emit('archive')"
	>
		<template #lead>
			<PostboxUnsubscribeChip
				v-if="listMessage?.unsubscribe && mailboxId"
				class="flex-shrink-0 mx-1"
				:message-id="listMessage._id"
				:mailbox-id="mailboxId"
				:unsubscribe="listMessage.unsubscribe"
				:sender-name="listMessage.fromName || listMessage.fromAddress"
			/>
		</template>
		<PostboxThreadMenu
			v-bind="menuProps"
			v-on="menuOn"
			@why-here="emit('why-here', stickyBarRef?.$el ?? null)"
		/>
	</PostboxReaderStickyBar>
	<!-- Focusable from script only: the sticky bar's "back to top" lands here,
	     since the bar it was clicked in hides as the header comes back. -->
	<header
		ref="headerEl"
		tabindex="-1"
		class="pbx-reader-header mb-3 outline-none"
		data-reader-chrome="header"
	>
		<!-- A topic name gets its own row: the verbs wrap below it rather than squeeze it. -->
		<div class="flex items-start gap-2" :class="heading ? 'flex-wrap' : ''">
			<!-- The verbs stay siblings of the header rather than its #actions: on a
			     phone they shrink to icons and keep to the subject's line, where the
			     header's actions row would drop them below it. -->
			<UiPageHeader class="flex-1 min-w-0" :class="heading ? 'basis-full' : ''">
				<template #title>
					<!-- From the People view: the topic name, renamed in place, whatever the count. -->
					<template v-if="heading && isRenaming">
						<span class="input block w-full">
							<input
								ref="renameInput"
								v-model="renameDraft"
								type="text"
								maxlength="80"
								:aria-label="t('components.postbox.people.topicBar.rename')"
								class="input-bare w-full text-[length:inherit]"
								@keydown.enter.prevent="saveRename"
								@keydown.esc.stop.prevent="isRenaming = false"
								@blur="saveRename"
							/>
						</span>
						<!-- The way back sits with the name it undoes; mousedown keeps the
						     input from saving on blur first. -->
						<button
							v-if="heading.source === 'user'"
							type="button"
							class="mt-1 block text-xs font-normal text-text-secondary underline decoration-dotted underline-offset-2 hover:text-text-primary"
							@mousedown.prevent
							@click="resetName"
						>
							{{ t('components.postbox.people.topicBar.reset') }}
						</button>
					</template>
					<!-- A topic name is set in the display serif, the face its person page uses. -->
					<span v-else-if="heading" class="font-display font-normal">{{ subjectText }}</span>
					<template v-else-if="messageCount > 1"
						>{{ subjectParts.head
						}}<span class="whitespace-nowrap"
							>{{ subjectParts.tail
							}}<span class="ml-1.5 text-base font-normal text-text-tertiary align-middle"
								>({{ messageCount }})</span
							></span
						></template
					>
					<template v-else>{{ subjectText }}</template>
					<UiTooltip
						v-if="heading && !isRenaming"
						:text="
							heading.source === 'ai'
								? t('components.postbox.people.topic.namedByOwlat')
								: heading.source === 'user'
									? t('components.postbox.people.topicBar.namedByYou')
									: t('components.postbox.people.topicBar.rename')
						"
					>
						<button
							type="button"
							class="ml-2 inline-flex h-7 w-7 items-center justify-center rounded align-middle text-text-tertiary outline-none hover:bg-bg-surface hover:text-text-primary focus-visible:ring-2 focus-visible:ring-brand/40"
							:aria-label="t('components.postbox.people.topicBar.rename')"
							@click="startRename"
						>
							<PencilIcon class="h-3.5 w-3.5" />
						</button>
					</UiTooltip>
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
					<ReplyIcon class="w-4 h-4 sm:hidden" aria-hidden="true" />
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
					<ArchiveIcon class="w-4 h-4 sm:hidden" aria-hidden="true" />
					<span class="max-sm:sr-only">{{ t('postbox.reader.header.archive') }}</span>
				</UiButton>
			</UiTooltip>
			<UiButton
				v-if="heading?.noReply"
				variant="ghost"
				size="sm"
				class="flex-shrink-0"
				:aria-label="t('components.postbox.people.topic.noReplyNeeded')"
				@click="heading.noReply()"
			>
				<CheckIcon class="w-4 h-4" aria-hidden="true" />
				<span class="max-sm:sr-only">{{ t('components.postbox.people.topic.noReplyNeeded') }}</span>
			</UiButton>
			<!-- Host-owned thread actions (the reader's "Discuss" toggle). -->
			<slot name="actions" />
			<PostboxThreadMenu v-bind="menuProps" v-on="menuOn" @why-here="emit('why-here', headerEl)" />
		</div>
	</header>
</template>
