<script setup lang="ts">
/**
 * A current conversation on a person's or company's page, named by its topic.
 * Every card answers three questions without opening it: what it is about,
 * whose turn it is, and what is still open. The spark marks a name Owlat
 * wrote; the original subject is one hover away and in the reader.
 *
 * The whole card opens the conversation (one stretched link), so the card can
 * also carry its own buttons: "No reply needed" takes it out of the Answer
 * queue (the queue's own "done": a new message puts it back), and Archive (or
 * the archive key on the focused card) files it away into Earlier, with the
 * Postbox's own undo notice, and hands focus to the next card.
 *
 * System mail (`isSystemMail`) is no conversation: it has no turn and no reply
 * to skip, only what it asks (the open item) and whether it is unread.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	ArchiveIcon,
	CheckboxIcon,
	PaperclipIcon,
	SparkleIcon,
	CalendarIcon,
	CheckIcon,
	ReplyIcon,
} from '@coolicons/vue';
import { usePostboxThreadTimestamp } from '~/composables/postbox/usePostboxListClock';
import { askingSentence, dueParts, previewText, type PeopleTopic } from '~/utils/postboxPeople';
import type { ShortcutScope } from '~/utils/shortcutRegistry';
import { chordFromEvent } from '~/utils/shortcutRegistry';
import { resolveActiveChord } from '~/utils/shortcutScope';

const props = defineProps<{
	topic: PeopleTopic;
	to: string;
	/** Display name per party key, for "Lena:" and "with" avatars. */
	names: ReadonlyMap<string, string>;
	/** The page this card is on: not repeated in "with". */
	pageKeys: readonly string[];
	/** Team inbox: the turn reads "the team", not "you". */
	isShared: boolean;
	/** A company account's mail: no turn, no reply to skip. */
	isSystemMail?: boolean;
	/** Who the conversation is with, on a page that is not that person's ("With Lena Hartmann"). */
	byline?: string;
}>();

const { t, locale } = useI18n();
const formatTimestamp = usePostboxThreadTimestamp();

const nameOf = (key: string) => props.names.get(key) ?? key;
const firstName = (key: string) => nameOf(key).split(' ')[0] ?? nameOf(key);

const speaker = computed(() =>
	props.topic.latestFromKey
		? firstName(props.topic.latestFromKey)
		: t('components.postbox.people.topic.you')
);
const line = computed(() => {
	const brief = props.topic.latestLine;
	if (brief) return { ask: null, rest: locale.value === 'de' ? brief.de : brief.en };
	const key = props.topic.latestFromKey;
	const text = previewText(props.topic.snippet, key ? firstName(key) : undefined);
	// A maybe leads with what it asks, ahead of the thanks around it.
	const ask = props.topic.turn === 'you' && !props.topic.isAsk ? askingSentence(text) : null;
	return ask ? { ask, rest: text.replace(ask, '').trim() } : { ask: null, rest: text };
});
// On the writer's own page their name before every line says nothing new.
const showSpeaker = computed(
	() =>
		!props.byline &&
		(!props.topic.latestFromKey || !props.pageKeys.includes(props.topic.latestFromKey))
);
// Who else is in it: not the page's own, and not the speaker already named above.
const others = computed(() =>
	props.topic.partyKeys.filter(
		(k) => !props.pageKeys.includes(k) && k !== props.topic.latestFromKey
	)
);
// Who the turn is with: the one other party when there is one; in a group
// nobody can be named without knowing whose item it is.
const waitingOn = computed(() =>
	props.topic.partyKeys.length === 1
		? t('components.postbox.people.topic.waitingThem', {
				name: firstName(props.topic.partyKeys[0]!),
			})
		: t('components.postbox.people.topic.waitingOthers')
);
const withNames = computed(() => {
	const names = others.value.map(firstName);
	return names.length <= 2
		? names.join(', ')
		: `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
});
const openItem = computed(() => {
	const item = props.topic.openItem;
	if (!item) return null;
	// The same "Due Nov 8" / "Overdue Nov 2" as every other People surface.
	const parts = item.dueAt ? dueParts(item.dueAt, locale.value) : null;
	const due = parts
		? t(`components.postbox.people.row.${parts.isOverdue ? 'overdueOn' : 'dueOn'}`, {
				date: parts.date,
			})
		: null;
	return {
		text: locale.value === 'de' ? item.text.de : item.text.en,
		due,
		isOverdue: parts?.isOverdue ?? false,
		isOurs: item.isOurs,
	};
});
const isUnread = computed(() => props.topic.unreadCount > 0);
const triageUndo = usePostboxTriageUndo();
const cardEl = ref<HTMLElement | null>(null);

const clearOp = useBackendOperation(api.mail.needsReply.clear, {
	label: () => t('components.postbox.people.topic.noReplyNeeded'),
});
const restoreOp = useBackendOperation(api.mail.needsReplyRestore.restore, {
	label: () => t('components.postbox.people.topic.noReplyUndone'),
});
// The flag is gone at once, so say so where the status was: a card that only
// loses its status reads as if nothing happened. The Postbox's undo notice
// puts the flag back, as Archive's does the mail.
const isMarkedNoReply = ref(false);
async function markNoReply() {
	const threadId = props.topic.id as Id<'mailThreads'>;
	const result = await clearOp.run({ threadId });
	if (!result.ok) return;
	isMarkedNoReply.value = true;
	triageUndo.register({
		label: t('components.postbox.people.topic.markedNoReplyOn', { title: props.topic.title }),
		inverse: async () => {
			isMarkedNoReply.value = false;
			await restoreOp.run({ threadId });
		},
	});
}
function neighbourCard(): HTMLElement | undefined {
	const cards = [...document.querySelectorAll<HTMLElement>('[data-topic-card]')];
	const at = cards.indexOf(cardEl.value!);
	return cards[at + 1] ?? cards[at - 1];
}
function focusCard(card: HTMLElement | undefined) {
	(card?.matches('a') ? card : card?.querySelector<HTMLElement>('a'))?.focus();
}
// A card that leaves the list with focus in it (an old conversation marked
// "No reply needed" drops out of Current) hands focus to its neighbour.
onBeforeUnmount(() => {
	if (cardEl.value?.contains(document.activeElement)) focusCard(neighbourCard());
});
const archiveOp = useBackendOperation(api.mail.threadArchive.archiveThreads, {
	label: () => t('components.postbox.people.topic.archive'),
});
const moveOp = useBackendOperation(api.mail.messageActions.move, {
	label: () => t('components.postbox.people.topic.archive'),
});
async function archive() {
	// The card leaves Current: hand focus to the next one before it goes.
	const next = neighbourCard();
	const result = await archiveOp.run({
		threads: [{ threadId: props.topic.id as Id<'mailThreads'> }],
	});
	if (!result.ok) return;
	focusCard(next);
	const moved = result.result?.moved ?? [];
	triageUndo.registerMoveBack({
		label: t('components.postbox.people.topic.archived', { title: props.topic.title }),
		kind: 'archived',
		moved,
		runMove: (args) => moveOp.run(args),
	});
}
const CARD_SCOPES: readonly ShortcutScope[] = ['postbox'];
function onKeydown(event: KeyboardEvent) {
	if ((event.target as HTMLElement | null)?.closest('input, textarea')) return;
	if (resolveActiveChord(chordFromEvent(event), CARD_SCOPES) !== 'postbox.archive') return;
	event.preventDefault();
	void archive();
}
</script>

<template>
	<article
		ref="cardEl"
		data-topic-card
		class="group relative min-w-0 rounded-xl bg-bg-overlay px-4 pt-2.5 pb-1.5 shadow-surface-2 transition-shadow duration-(--motion-fast) hover:shadow-surface-3 hover:ring-1 hover:ring-border-strong focus-within:ring-2 focus-within:ring-brand/40 dark:bg-bg-elevated dark:shadow-none dark:ring-1 dark:ring-border-default"
		@keydown="onKeydown"
	>
		<NuxtLink :to="to" class="absolute inset-0 rounded-xl outline-none" :aria-label="topic.title" />
		<div class="pointer-events-none flex items-start gap-4">
			<h3 class="flex min-w-0 flex-1 items-start gap-2">
				<!-- The card leads with the same mark its row in every list carries. -->
				<PostboxPeopleMark
					:owed="topic.isAsk && !isMarkedNoReply ? 1 : 0"
					:may-owe="
						topic.turn === 'you' && !topic.isAsk && !isSystemMail && !isMarkedNoReply ? 1 : 0
					"
					:unread="topic.unreadCount"
					class="mt-[0.4rem]"
				/>
				<SparkleIcon
					v-if="topic.titleSource === 'ai'"
					class="mt-1 h-3.5 w-3.5 flex-shrink-0 text-accent"
					:aria-label="t('components.postbox.people.topic.namedByOwlat')"
				/>
				<span
					class="line-clamp-2 text-md leading-snug text-text-primary sm:line-clamp-1"
					:class="isUnread ? 'font-semibold' : 'font-medium'"
					>{{ topic.title }}</span
				>
			</h3>
			<span
				class="flex flex-shrink-0 items-center gap-1.5 pt-0.5 text-2xs tabular-nums text-text-tertiary"
			>
				{{ formatTimestamp(topic.lastMessageAt) }}
			</span>
		</div>
		<p v-if="byline" class="pointer-events-none mt-0.5 text-xs text-text-secondary">
			{{ byline }}
		</p>
		<!-- What is asked leads when it is known; the latest words are the fallback,
		     with room enough to show the request inside them. -->
		<p
			v-if="openItem"
			class="pointer-events-none mt-1.5 flex flex-wrap items-start gap-x-1.5 gap-y-0.5 text-sm text-text-primary sm:flex-nowrap"
		>
			<CheckboxIcon class="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
			<span class="min-w-0 flex-1">{{ openItem.text }}</span>
			<!-- On a phone the date takes its own line rather than squeeze the request. -->
			<span
				v-if="openItem.due"
				class="inline-flex flex-shrink-0 basis-full items-center gap-1 pl-5 text-xs sm:basis-auto sm:pl-0"
				:class="openItem.isOverdue ? 'font-semibold text-error' : 'text-warning'"
			>
				<CalendarIcon class="h-3 w-3" />{{ openItem.due }}
			</span>
		</p>
		<p
			class="pointer-events-none mt-1 text-sm text-text-secondary"
			:class="
				openItem ? 'truncate text-caption text-text-tertiary' : 'line-clamp-3 sm:line-clamp-2'
			"
		>
			<span v-if="showSpeaker" class="font-medium text-text-primary">{{ speaker }}: </span>
			<!-- What a maybe asks reads in the primary ink, the words around it quieter. -->
			<span v-if="line.ask" class="text-text-primary">{{ line.ask }}</span>
			{{ line.rest }}
		</p>
		<div class="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-text-tertiary">
			<span
				v-if="isSystemMail"
				class="pointer-events-none text-xs font-medium text-text-secondary"
				>{{ isUnread ? t('components.postbox.people.topic.unreadLabel') : '' }}</span
			>
			<span
				v-else-if="isMarkedNoReply"
				class="pointer-events-none inline-flex items-center gap-1 text-xs font-medium text-success"
				><CheckIcon class="h-3 w-3" />{{ t('components.postbox.people.topic.markedNoReply') }}</span
			>
			<!-- A request gets the brand pill; a maybe is already the ring before the
			     title, so this slot says what the ring cannot: who wrote last. -->
			<span
				v-else-if="topic.turn === 'you' && topic.isAsk"
				class="pointer-events-none rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand"
				>{{
					isShared
						? t('components.postbox.people.topic.waitingTeam')
						: t('components.postbox.people.topic.waitingYou')
				}}</span
			>
			<!-- Whoever wrote last, for a maybe and for a conversation with no open
			     turn alike: the slot is never empty on a human conversation. -->
			<!-- A maybe says so in words as well as in the ring, so the card explains
			     itself without the key. -->
			<span
				v-else-if="topic.turn === 'you' && !isSystemMail"
				class="pointer-events-none rounded-full px-2 py-0.5 text-xs font-medium text-brand ring-1 ring-inset ring-brand/40"
				>{{ t('components.postbox.people.topic.mayNeedReply') }}</span
			>
			<span
				v-else-if="topic.turn === 'none' && topic.latestFromKey"
				class="pointer-events-none text-xs text-text-tertiary"
				>{{
					t('components.postbox.people.topic.theyWroteLast', {
						name: firstName(topic.latestFromKey),
					})
				}}</span
			>
			<span
				v-else-if="topic.turn === 'them'"
				class="pointer-events-none rounded-full bg-info-subtle px-2 py-0.5 text-xs font-medium text-info"
				>{{ waitingOn }}</span
			>
			<span
				v-else-if="topic.turn === 'replied'"
				class="pointer-events-none text-xs text-text-tertiary"
				>{{ t('components.postbox.people.topic.youWroteLast') }}</span
			>
			<span class="pointer-events-none hidden tabular-nums sm:inline">{{
				t(
					'components.postbox.people.topic.messages',
					{ count: topic.messageCount },
					topic.messageCount
				)
			}}</span>
			<PaperclipIcon
				v-if="topic.hasAttachments"
				class="pointer-events-none h-3 w-3"
				:aria-label="t('components.postbox.people.topic.attachments')"
			/>
			<span v-if="others.length > 0" class="pointer-events-none inline-flex items-center gap-1">
				<span class="flex -space-x-1">
					<PostboxPeopleAvatar
						v-for="key in others.slice(0, 2)"
						:key="key"
						kind="person"
						:name="nameOf(key)"
						:color-key="key"
						size="sm"
						class="rounded-full ring-2 ring-bg-overlay"
					/>
				</span>
				{{ t('components.postbox.people.topic.withNames', { names: withNames }) }}
			</span>
			<span class="relative z-10 ml-auto flex items-center justify-end gap-0.5">
				<UiTooltip :text="t('components.postbox.people.topic.noReplyHelp')">
					<button
						v-if="topic.turn === 'you' && !isSystemMail"
						type="button"
						:aria-label="t('components.postbox.people.topic.noReplyNeeded')"
						class="inline-flex min-h-11 min-w-11 justify-center items-center gap-1 rounded-md px-2 text-xs font-medium text-text-secondary outline-none sm:min-h-7 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100 hover:bg-bg-surface hover:text-text-primary focus-visible:ring-2 focus-visible:ring-brand/40"
						:disabled="clearOp.isLoading.value"
						@click="markNoReply"
					>
						<CheckIcon class="h-3.5 w-3.5" />
						<span class="max-sm:sr-only">{{
							t('components.postbox.people.topic.noReplyNeeded')
						}}</span>
					</button>
				</UiTooltip>
				<button
					type="button"
					class="inline-flex min-h-11 min-w-11 justify-center items-center gap-1 rounded-md px-2 text-xs font-medium text-text-secondary outline-none sm:min-h-7 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100 hover:bg-bg-surface hover:text-text-primary focus-visible:ring-2 focus-visible:ring-brand/40"
					:disabled="archiveOp.isLoading.value"
					:aria-label="t('components.postbox.people.topic.archive')"
					@click="archive"
				>
					<ArchiveIcon class="h-3.5 w-3.5" />
					<span class="max-sm:sr-only">{{ t('components.postbox.people.topic.archive') }}</span>
				</button>
				<!-- The answer one step away, at the card's edge where the eye ends: opens
				     the conversation with the reply ready (the reader takes `?reply=1` once). -->
				<NuxtLink
					v-if="!isSystemMail && !isMarkedNoReply"
					:to="`${to}${to.includes('?') ? '&' : '?'}reply=1`"
					class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-semibold text-text-primary outline-none sm:min-h-7 hover:bg-bg-surface focus-visible:ring-2 focus-visible:ring-brand/40"
				>
					<ReplyIcon class="h-3.5 w-3.5" />
					<span>{{ t('components.postbox.people.topic.reply') }}</span>
				</NuxtLink>
			</span>
		</div>
	</article>
</template>
