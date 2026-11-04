<script setup lang="ts">
/**
 * One row of the People column: a person, a group of people at one company,
 * or a company. Who, when, the topic it leads with, and how much is waiting.
 * The row is a link to the page, so it opens in a new tab like any other.
 */
import { usePostboxThreadTimestamp } from '~/composables/postbox/usePostboxListClock';
import { highlightParts } from '~/utils/postboxPeople';
import { ChatIcon } from '@coolicons/vue';

const props = defineProps<{
	kind: 'person' | 'company';
	name: string;
	colorKey?: string;
	logoUrl?: string;
	/** An automated sender (no people): its tile carries the bell. */
	isAutomated?: boolean;
	/** What an automated sender sends most, for its tile. */
	senderKind?: string | null;
	/** A short tag after the name: the company a person works at, a company's kind. */
	tag?: string;
	to: string;
	isActive: boolean;
	lastAt: number;
	/** The topic it leads with. */
	topic?: string;
	/** More topics beyond the one shown. */
	moreTopics: number;
	unread: number;
	/** Topics waiting on the mailbox, on evidence. */
	owed: number;
	/** Topics whose turn is the mailbox's without that evidence. */
	mayOwe?: number;
	/** Whose avatar it is, when the row's name is a conversation's (a search result). */
	avatarName?: string;
	/** The due date has passed: red, as everywhere a date is overdue. */
	isOverdue?: boolean;
	/** Search terms to mark in the name and the topic line. */
	highlight?: readonly string[];
	/** When the request it leads with is due ("Due Nov 8"), beside the mark. */
	due?: string;
}>();

const { t } = useI18n();
const formatTimestamp = usePostboxThreadTimestamp();
const isUnread = computed(() => props.unread > 0);
const label = computed(() =>
	[
		props.name,
		props.tag,
		props.topic,
		props.moreTopics > 0
			? t('components.postbox.people.row.more', { count: props.moreTopics }, props.moreTopics)
			: '',
		props.owed > 0
			? t('components.postbox.people.row.owed', { count: props.owed }, props.owed)
			: '',
		(props.mayOwe ?? 0) > 0
			? t('components.postbox.people.row.mayOwe', { count: props.mayOwe ?? 0 }, props.mayOwe ?? 0)
			: '',
		isUnread.value
			? t('components.postbox.people.row.unread', { count: props.unread }, props.unread)
			: '',
	]
		.filter(Boolean)
		.join(', ')
);
</script>

<template>
	<NuxtLink
		:to="to"
		:aria-label="label"
		:aria-current="isActive ? 'page' : undefined"
		data-people-row
		class="group relative flex items-center gap-3 px-3.5 py-2 outline-none transition-colors duration-(--motion-fast) focus-visible:bg-(--surface-2-selected) focus-visible:shadow-[inset_2px_0_0_var(--color-brand)]"
		:class="isActive ? 'bg-(--surface-2-selected)' : 'hover:bg-(--surface-2-hover)'"
	>
		<span
			v-if="isActive"
			class="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-brand"
			aria-hidden="true"
		/>
		<!-- A conversation found by search gets a speech tile, so it never reads
		     as a person row. -->
		<span
			v-if="avatarName"
			class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-bg-surface text-text-secondary ring-1 ring-inset ring-border-default"
			aria-hidden="true"
			><ChatIcon class="h-4 w-4"
		/></span>
		<PostboxPeopleAvatar
			v-else
			:kind="kind"
			:name="name"
			:color-key="colorKey"
			:logo-url="logoUrl"
			:is-automated="isAutomated"
			:sender-kind="senderKind"
			size="md"
		/>
		<span class="min-w-0 flex-1">
			<span class="flex items-baseline gap-1.5">
				<span
					class="truncate text-sm"
					:class="
						isUnread && isAutomated
							? 'font-medium text-text-primary'
							: isAutomated
								? 'text-text-secondary'
								: isUnread
									? 'font-semibold text-text-primary'
									: kind === 'company'
										? 'text-text-secondary'
										: 'text-text-primary'
					"
					><template v-if="highlight?.length"
						><template v-for="(part, i) in highlightParts(name, highlight)" :key="i"
							><mark
								v-if="part.isHit"
								class="rounded-sm bg-brand-soft px-px font-semibold text-text-primary underline decoration-brand underline-offset-2"
								>{{ part.text }}</mark
							><template v-else>{{ part.text }}</template></template
						></template
					><template v-else>{{ name }}</template></span
				>
				<span
					v-if="tag"
					class="hidden flex-shrink-0 truncate text-2xs leading-4 text-text-tertiary max-w-[45%] sm:inline"
					:class="isAutomated ? '' : 'rounded px-1 bg-bg-surface'"
					>{{ tag }}</span
				>
				<span class="ml-auto flex-shrink-0 text-2xs tabular-nums text-text-tertiary">{{
					formatTimestamp(lastAt)
				}}</span>
			</span>
			<!-- The line wraps to two for a request or a maybe, so what is asked (and
			     by when) survives the column's width; the due date and the mark keep
			     a trailing slot of their own. -->
			<span class="mt-0.5 flex items-start gap-1.5 text-caption">
				<span
					class="min-w-0 flex-1"
					:class="[
						isUnread ? 'text-text-primary' : 'text-text-secondary',
						owed > 0 || (mayOwe ?? 0) > 0 || kind === 'company' ? 'line-clamp-2' : 'truncate',
					]"
					><template v-if="highlight?.length && topic"
						><template v-for="(part, i) in highlightParts(topic, highlight)" :key="i"
							><mark
								v-if="part.isHit"
								class="rounded-sm bg-brand-soft px-px font-semibold text-text-primary underline decoration-brand underline-offset-2"
								>{{ part.text }}</mark
							><template v-else>{{ part.text }}</template></template
						></template
					><template v-else>{{ topic }}</template></span
				>
				<span class="flex flex-shrink-0 items-center gap-1.5 pt-0.5">
					<span
						v-if="due"
						class="rounded-full px-1.5 text-2xs font-semibold leading-4"
						:class="isOverdue ? 'bg-error-subtle text-error' : 'bg-warning-subtle text-warning'"
						>{{ due }}</span
					>
					<PostboxPeopleMark :owed="owed" :may-owe="mayOwe ?? 0" :unread="unread" />
				</span>
			</span>
			<!-- More open conversations with them, in words under the ask, apart
			     from the mark, which counts what waits rather than what exists. -->
			<span v-if="moreTopics > 0" class="mt-0.5 block text-2xs text-text-tertiary">{{
				t('components.postbox.people.row.more', { count: moreTopics }, moreTopics)
			}}</span>
		</span>
	</NuxtLink>
</template>
