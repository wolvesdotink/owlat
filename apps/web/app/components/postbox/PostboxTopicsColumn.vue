<script setup lang="ts">
/**
 * The column while a conversation is open from a person's or company's page:
 * that page's conversations, current first, so the next one is a click away
 * and the person you came from stays in view. The back link returns to the
 * page with the people beside it.
 */
import { ChevronLeftIcon, SparkleIcon } from '@coolicons/vue';
import { usePostboxThreadTimestamp } from '~/composables/postbox/usePostboxListClock';
import {
	askingSentence,
	dueOf,
	dueParts,
	previewText,
	splitTopics,
	type PeopleTopic,
} from '~/utils/postboxPeople';
import { walkTopicCards } from '~/composables/postbox/usePostboxPeople';

const props = defineProps<{
	name: string;
	kind: 'person' | 'company';
	colorKey?: string;
	logoUrl?: string;
	topics: readonly PeopleTopic[];
	activeMessageId: string;
	hrefFor: (topic: PeopleTopic) => string;
	/** Team inbox: the turn reads "the team", not "you". */
	isShared: boolean;
}>();
const emit = defineEmits<{ back: [] }>();

const { t, locale } = useI18n();
const formatTimestamp = usePostboxThreadTimestamp();
const split = computed(() => splitTopics(props.topics));
// The same turn words as the cards, so a topic reads the same in both places.
function turnLabel(topic: PeopleTopic): string {
	if (topic.turn === 'you' && !topic.isAsk)
		return t('components.postbox.people.topic.mayNeedReply');
	if (topic.turn === 'you')
		return props.isShared
			? t('components.postbox.people.topic.waitingTeam')
			: t('components.postbox.people.topic.waitingYou');
	if (topic.turn === 'them')
		return topic.partyKeys.length === 1
			? t('components.postbox.people.topic.waitingThem', {
					name: props.name.split(' ')[0] ?? props.name,
				})
			: t('components.postbox.people.topic.waitingOthers');
	if (topic.turn === 'replied') return t('components.postbox.people.topic.youWroteLast');
	return '';
}
// Under the title, what moves the conversation: the request when one is
// known, whose turn when it is theirs, else the latest words. The mark beside
// the title already says whether a reply is due.
function secondLine(topic: PeopleTopic): string {
	if (topic.openItem?.isOurs)
		return locale.value === 'de' ? topic.openItem.text.de : topic.openItem.text.en;
	if (topic.turn === 'them' || topic.turn === 'replied') return turnLabel(topic);
	const text = previewText(topic.snippet, props.name.split(' ')[0]);
	// A maybe leads with what it asks, as its row in the people column does.
	return (topic.turn === 'you' && !topic.isAsk ? askingSentence(text) : null) ?? text;
}
function dueText(at: number): string {
	const { date, isOverdue } = dueParts(at, locale.value);
	return isOverdue
		? t('components.postbox.people.row.overdueOn', { date })
		: t('components.postbox.people.row.dueOn', { date });
}
const groups = computed(() => [
	{ id: 'now', title: t('components.postbox.people.page.now'), topics: split.value.now },
	{
		id: 'earlier',
		title: t('components.postbox.people.page.earlier'),
		topics: split.value.earlier,
	},
]);
</script>

<template>
	<section
		class="flex h-full min-h-0 w-full flex-col bg-bg-elevated"
		:aria-label="t('components.postbox.people.topicsColumn.label', { name })"
	>
		<header class="border-b border-border-subtle px-3.5 pt-3 pb-3">
			<button
				type="button"
				class="-ml-1.5 inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-caption text-text-secondary outline-none hover:bg-bg-surface hover:text-text-primary focus-visible:ring-2 focus-visible:ring-brand/40"
				@click="emit('back')"
			>
				<ChevronLeftIcon class="h-3.5 w-3.5" />
				{{ t('components.postbox.people.topicsColumn.back', { name: name.split(' ')[0] ?? name }) }}
			</button>
			<div class="mt-2 flex items-center gap-2.5">
				<PostboxPeopleAvatar
					:kind="kind"
					:name="name"
					:color-key="colorKey"
					:logo-url="logoUrl"
					size="md"
				/>
				<h2 class="truncate text-md font-semibold text-text-primary">{{ name }}</h2>
			</div>
		</header>
		<div class="flex-1 overflow-y-auto pb-6" @keydown="walkTopicCards">
			<template v-for="group in groups" :key="group.id">
				<section v-if="group.topics.length > 0" :aria-label="group.title">
					<h3
						class="px-3.5 pt-4 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-text-tertiary"
					>
						{{ group.title }}
					</h3>
					<NuxtLink
						v-for="topic in group.topics"
						:key="topic.id"
						:to="hrefFor(topic)"
						data-topic-card
						:aria-current="topic.latestMessageId === activeMessageId ? 'page' : undefined"
						class="relative flex flex-col gap-0.5 px-3.5 py-2 outline-none transition-colors duration-(--motion-fast) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40"
						:class="
							topic.latestMessageId === activeMessageId
								? 'bg-(--surface-2-selected)'
								: 'hover:bg-(--surface-2-hover)'
						"
					>
						<span
							v-if="topic.latestMessageId === activeMessageId"
							class="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-brand"
							aria-hidden="true"
						/>
						<span class="flex items-baseline gap-1.5">
							<SparkleIcon
								v-if="topic.titleSource === 'ai'"
								class="h-3 w-3 flex-shrink-0 self-center text-accent"
							/>
							<span
								class="truncate text-sm text-text-primary"
								:class="topic.unreadCount > 0 ? 'font-semibold' : 'font-medium'"
								>{{ topic.title }}</span
							>
							<span class="ml-auto flex-shrink-0 text-2xs tabular-nums text-text-tertiary">{{
								formatTimestamp(topic.lastMessageAt)
							}}</span>
						</span>
						<!-- The mark sits where the people column puts it: right, under the date. -->
						<!-- Two lines for what is asked, as in the people column, and its date
						     beside the mark, overdue set apart from upcoming. -->
						<span class="flex items-start gap-2">
							<span
								class="min-w-0 flex-1 text-caption text-text-secondary"
								:class="topic.turn === 'you' ? 'line-clamp-2' : 'truncate'"
								>{{ secondLine(topic) }}</span
							>
							<span
								v-if="dueOf(topic) !== undefined"
								class="flex-shrink-0 rounded-full px-1.5 text-2xs font-semibold leading-4"
								:class="
									dueParts(dueOf(topic)!, locale).isOverdue
										? 'bg-error-subtle text-error'
										: 'bg-warning-subtle text-warning'
								"
								>{{ dueText(dueOf(topic)!) }}</span
							>
							<PostboxPeopleMark
								:owed="topic.isAsk ? 1 : 0"
								:may-owe="topic.turn === 'you' && !topic.isAsk ? 1 : 0"
								:unread="topic.unreadCount"
								size="sm"
							/>
						</span>
					</NuxtLink>
				</section>
			</template>
		</div>
	</section>
</template>
