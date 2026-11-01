<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import {
	ArchiveIcon,
	ChatHelpIcon,
	CheckIcon,
	CircleHelpIcon,
	ClockIcon,
	FileTextIcon,
	ListUnorderedIcon,
	MailOpenIcon,
	ReplyIcon,
	UndoIcon,
} from '@coolicons/vue';

/**
 * The calm reader's header line (read on arrival §3): the subject,
 * Reply, Archive and ONE ⋯ menu. Nothing else sits between the subject and
 * the strip: the follow-up chip, the team badge, the labels and the
 * cross-surface link moved into the strip's Details row.
 *
 * The ⋯ menu holds the conversation's state as checkable items (pinned, alert
 * on reply, muted, back-from-snooze, mark-read under the `manual` policy), the
 * ways into the strip that also work without one ("Why is this here?",
 * "Details", and "Full brief", the only way to the brief when the viewer turned
 * the strip off), and the verbs that left the old Overview's button row (Snooze,
 * "Ask about this thread").
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

const isMuted = computed(() => props.thread?.mutedAt != null);
const isAlerted = computed(() => props.thread?.notifyOnReplyAt != null);
const isPinned = computed(() => props.thread?.pinnedAt != null);
const cameBackFromSnooze = computed(() => props.thread?.snoozeReturnedAt != null);

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

/** Shared item shape — one string rather than copies drifting apart. */
const ITEM_CLASS =
	'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left whitespace-nowrap text-text-primary hover:bg-bg-surface disabled:opacity-60';
const ICON_CLASS = 'w-3.5 h-3.5 flex-shrink-0 text-text-tertiary';
</script>

<template>
	<header ref="headerEl" class="pbx-reader-header mb-3" data-reader-chrome="header">
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
			<!-- Host-owned thread actions (the reader's "Discuss" toggle). -->
			<slot name="actions" />
			<PostboxOverflowMenu
				class="flex-shrink-0"
				:label="t('components.postbox.postboxThreadHeader.menuLabel')"
			>
				<template #default="{ close }">
					<button
						v-if="showWhyHere"
						type="button"
						role="menuitem"
						:class="ITEM_CLASS"
						data-testid="thread-menu-why-here"
						@click="
							emit('why-here', headerEl);
							close();
						"
					>
						<CircleHelpIcon :class="ICON_CLASS" aria-hidden="true" size="1em" />
						{{ t('postbox.reader.header.whyHere') }}
					</button>
					<button
						type="button"
						role="menuitem"
						:class="ITEM_CLASS"
						data-testid="thread-menu-details"
						@click="
							emit('details');
							close();
						"
					>
						<ListUnorderedIcon :class="ICON_CLASS" aria-hidden="true" size="1em" />
						{{ t('postbox.reader.header.details') }}
					</button>
					<button
						v-if="showFullBrief"
						type="button"
						role="menuitem"
						:class="ITEM_CLASS"
						data-testid="thread-menu-full-brief"
						@click="
							emit('full-brief');
							close();
						"
					>
						<FileTextIcon :class="ICON_CLASS" aria-hidden="true" size="1em" />
						{{ t('postbox.reader.header.fullBrief') }}
					</button>
					<button
						type="button"
						role="menuitem"
						:class="ITEM_CLASS"
						data-testid="thread-menu-snooze"
						@click="
							emit('snooze');
							close();
						"
					>
						<ClockIcon :class="ICON_CLASS" aria-hidden="true" size="1em" />
						{{ t('postbox.reader.header.snooze') }}
					</button>
					<button
						v-if="showAsk"
						type="button"
						role="menuitem"
						:class="ITEM_CLASS"
						data-testid="thread-menu-ask"
						@click="
							emit('ask');
							close();
						"
					>
						<ChatHelpIcon :class="ICON_CLASS" aria-hidden="true" size="1em" />
						{{ t('postbox.reader.header.ask') }}
					</button>
					<div class="my-1 border-t border-border-subtle" role="separator" />
					<!-- The conversation's state, made checkable. -->
					<UiTooltip :text="t('components.postbox.postboxThreadHeader.pinHint')">
						<button
							type="button"
							role="menuitemcheckbox"
							:aria-checked="isPinned"
							:class="ITEM_CLASS"
							data-testid="thread-menu-pin"
							@click="
								emit('toggle-pin');
								close();
							"
						>
							<CheckIcon
								class="w-3.5 h-3.5 flex-shrink-0 text-brand"
								:class="{ invisible: !isPinned }"
								aria-hidden="true"
							/>
							{{ t('components.postbox.postboxThreadHeader.pinConversation') }}
						</button>
					</UiTooltip>
					<UiTooltip :text="t('components.postbox.postboxThreadHeader.alertedHint')">
						<button
							type="button"
							role="menuitemcheckbox"
							:aria-checked="isAlerted"
							:class="ITEM_CLASS"
							data-testid="thread-menu-alert"
							@click="
								emit('toggle-alert');
								close();
							"
						>
							<CheckIcon
								class="w-3.5 h-3.5 flex-shrink-0 text-brand"
								:class="{ invisible: !isAlerted }"
								aria-hidden="true"
							/>
							{{ t('components.postbox.postboxThreadHeader.alertOnReply') }}
						</button>
					</UiTooltip>
					<UiTooltip :text="t('components.postbox.postboxThreadHeader.unmuteHint')">
						<button
							type="button"
							role="menuitemcheckbox"
							:aria-checked="isMuted"
							:class="ITEM_CLASS"
							data-testid="thread-menu-mute"
							@click="
								emit('toggle-mute');
								close();
							"
						>
							<CheckIcon
								class="w-3.5 h-3.5 flex-shrink-0 text-brand"
								:class="{ invisible: !isMuted }"
								aria-hidden="true"
							/>
							{{ t('components.postbox.postboxThreadHeader.muteConversation') }}
						</button>
					</UiTooltip>
					<!-- Mark-read is an ACTION, not a state, and only exists under the
					     manual mark-read policy while the thread still has unread mail. -->
					<button
						v-if="showMarkRead"
						type="button"
						role="menuitem"
						:class="ITEM_CLASS"
						:disabled="markingRead"
						data-testid="thread-menu-mark-read"
						@click="
							emit('mark-read');
							close();
						"
					>
						<MailOpenIcon :class="ICON_CLASS" aria-hidden="true" size="1em" />
						{{ t('components.postbox.postboxThreadHeader.markRead') }}
					</button>
					<!-- The one-shot "you asked for this back" cue: a state with no verb,
					     so it reads as a checked, non-actionable row. -->
					<p
						v-if="cameBackFromSnooze"
						role="menuitem"
						aria-disabled="true"
						:class="ITEM_CLASS"
						data-testid="thread-menu-back-from-snooze"
					>
						<UndoIcon :class="ICON_CLASS" aria-hidden="true" size="1em" />
						{{ t('components.postbox.postboxThreadHeader.backFromSnooze') }}
					</p>
				</template>
			</PostboxOverflowMenu>
		</div>
	</header>
</template>
