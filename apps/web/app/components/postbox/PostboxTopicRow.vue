<script setup lang="ts">
/**
 * One current conversation on a person's or company's page: its topic, a
 * one-word cue when it may need a reply ("Reply?") or a follow-up is armed
 * ("Waiting on Lena"), and under it what is asked, with its due date, or the
 * latest words with their author.
 *
 * "Reply?" keeps its question mark: it is a reading of the mail, not a fact,
 * and "No reply needed" sits right beside it to say so.
 */
import { CheckIcon } from '@coolicons/vue';
import {
	authorName,
	dueUrgency,
	rowSaying,
	type DirectoryIndex,
} from '~/utils/postboxConversations';
import type { PeopleTopic } from '~/utils/postboxPeople';
import {
	usePostboxListNow,
	usePostboxThreadTimestamp,
} from '~/composables/postbox/usePostboxListClock';

const props = defineProps<{
	topic: PeopleTopic;
	index: DirectoryIndex;
	href: string;
	isShared: boolean;
	/** On a company page each row leads with who it is with. */
	showParty?: boolean;
	/** The card treatment, for the first conversation that may need a reply. */
	isRaised?: boolean;
}>();
const emit = defineEmits<{ 'no-reply': [topic: PeopleTopic] }>();

const { t, locale } = useI18n();
const now = usePostboxListNow();
const stamp = usePostboxThreadTimestamp();
const lang = computed<'en' | 'de'>(() => (locale.value.startsWith('de') ? 'de' : 'en'));
const saying = computed(() => rowSaying(props.index, props.topic, lang.value));
const you = computed(() =>
	props.isShared
		? t('components.postbox.conversations.line.team')
		: t('components.postbox.conversations.line.you')
);
const isUnread = computed(() => props.topic.unreadCount > 0);
const party = computed(() => {
	const key = props.topic.latestFromKey ?? props.topic.partyKeys[0];
	if (!key) return null;
	const person = props.index.people.get(key);
	return person
		? { kind: 'person' as const, name: person.name, key }
		: { kind: 'company' as const, name: props.index.accounts.get(key)?.name ?? key, key };
});
const waitingOn = computed(() => {
	const key =
		props.topic.partyKeys.find((k) => props.index.people.has(k)) ?? props.topic.partyKeys[0];
	return key ? authorName(props.index, key) : '';
});
const due = computed(() => {
	const s = saying.value;
	if (s.kind !== 'ask' || s.dueAt === undefined) return null;
	const weekday = s.dueAt - now.value < 6 * 86_400_000 && s.dueAt > now.value - 86_400_000;
	const label = new Intl.DateTimeFormat(
		locale.value,
		weekday ? { weekday: 'short' } : { day: 'numeric', month: 'short' }
	).format(s.dueAt);
	return { label, urgency: dueUrgency(s.dueAt, now.value) };
});
</script>

<template>
	<div
		data-topic-card
		class="group relative -mx-3.5 flex gap-3.5 rounded-xl px-3.5 py-3.5 transition-colors"
		:class="
			isRaised
				? 'bg-bg-base shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-border-subtle'
				: 'hover:bg-bg-surface-hover'
		"
	>
		<PostboxPeopleAvatar
			v-if="showParty && party"
			class="mt-0.5"
			:kind="party.kind"
			size="sm"
			:name="party.name"
			:color-key="party.kind === 'person' ? party.key : undefined"
		/>
		<div class="min-w-0 flex-1">
			<div class="flex items-baseline gap-2.5">
				<NuxtLink
					:to="href"
					class="min-w-0 flex-1 truncate text-[0.9375rem] text-text-primary outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-brand/40"
					:class="isUnread ? 'font-bold' : 'font-semibold'"
				>
					{{ topic.title }}
				</NuxtLink>
				<span
					v-if="topic.turn === 'you'"
					class="flex-shrink-0 text-xs font-semibold text-brand-muted"
					>{{ t('components.postbox.conversations.cue.reply') }}</span
				>
				<span
					v-else-if="topic.turn === 'them'"
					class="flex-shrink-0 text-xs font-semibold text-info"
					>{{ t('components.postbox.conversations.cue.waiting', { name: waitingOn }) }}</span
				>
				<span class="flex-shrink-0 text-xs tabular-nums text-text-tertiary">{{
					stamp(topic.lastMessageAt)
				}}</span>
			</div>
			<p v-if="saying.kind === 'ask'" class="mt-1 text-sm text-text-primary">
				<span class="text-text-secondary">{{
					saying.author
						? t('components.postbox.conversations.line.asks', { name: saying.author })
						: t('components.postbox.conversations.line.asked')
				}}</span>
				{{ saying.text }}
				<span
					v-if="due"
					class="ml-1 inline-block rounded-md px-1.5 text-xs font-semibold"
					:class="
						due.urgency === 'due' ? 'bg-brand text-text-inverse' : 'bg-brand-soft text-brand-muted'
					"
					>{{ t('components.postbox.conversations.line.due', { date: due.label }) }}</span
				>
			</p>
			<p v-else class="mt-1 truncate text-[0.8125rem] text-text-secondary">
				<span class="font-semibold text-text-primary">{{ saying.line.author ?? you }}:</span>
				{{ saying.line.text }}
			</p>
		</div>
		<!-- Beside the cue it answers, and above the row's link. A phone has no
		     hover and no room: the conversation's own header offers it there. -->
		<button
			v-if="topic.turn === 'you'"
			type="button"
			class="relative z-10 hidden h-7 flex-shrink-0 items-center gap-1 self-center rounded-md px-2 text-xs font-medium text-text-secondary hover:bg-bg-surface hover:text-text-primary max-lg:!hidden focus-visible:flex group-focus-within:flex group-hover:flex"
			@click="emit('no-reply', topic)"
		>
			<CheckIcon class="h-3.5 w-3.5" />
			{{ t('components.postbox.conversations.cue.noReply') }}
		</button>
	</div>
</template>
