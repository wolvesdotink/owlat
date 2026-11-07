<script setup lang="ts">
/**
 * The Workbench's "What needs you": every piece of work waiting on the viewer
 * as one list of cards, whatever it arrived as (a reply the Answer queue
 * holds, a request that needs no reply, a task). A card leads with the work,
 * then who it is from, the company and the inbox, and offers the next step
 * right there: reply, open, make a task. A task taken from a conversation on
 * the list rides on that conversation's card with its own checkbox.
 *
 * The order and the grouping are `buildWorkCards` (utils/workbenchWork.ts);
 * the wording and its privacy rules are `useWorkRowText`.
 */
import type { Id } from '@owlat/api/dataModel';
import { companyKeyOf, companyKeyOfDomain, companyNameFromKey } from '@owlat/shared/companyKey';
import type { AnswerItem } from '~/composables/useAnswerQueue';
import { useWorkRowText } from '~/composables/useWorkRowText';
import { useTaskActions } from '~/composables/useTaskActions';
import TaskCreatePopover from '~/components/tasks/TaskCreatePopover.vue';
import CompanyTaskList from '~/components/companies/CompanyTaskList.vue';
import InboxChip from '~/components/inbox/InboxChip.vue';
import type { TaskView } from '~/types/tasks';
import type { InboxIdentity } from '~/utils/inboxIdentity';
import { parseFromHeader } from '~/utils/todayDigest';
import { taskDueBucket } from '~/utils/taskBuckets';
import { answerEffortParts, type AnswerCounts, type SummaryPart } from '~/utils/todayAnswerSummary';
import { buildWorkCards, type WorkCard, type WorkTodoRow } from '~/utils/workbenchWork';
import {
	ArrowRightIcon,
	BriefcaseIcon,
	CheckIcon,
	CircleCheckIcon,
	FlagIcon,
	ReplyIcon,
} from '@coolicons/vue';

const props = withDefaults(
	defineProps<{
		answer: readonly AnswerItem[];
		todo: readonly WorkTodoRow[];
		tasks: readonly TaskView[];
		counts: AnswerCounts;
		isLoading: boolean;
		/** The Answer queue, narrowed to this view (`?in=`). */
		queueHref: string;
		/** Name each card's inbox (the All view spans several). */
		showInbox?: boolean;
	}>(),
	{ showInbox: false }
);

/** Enough to see what comes next without a wall of cards; the rest is one click away. */
const SHOWN = 8;

const { t } = useI18n();
const { byId, inboxes } = useInboxes();
const answerRef = computed(() => props.answer);
const text = useWorkRowText(answerRef);
const { setStatus } = useTaskActions();

// Read when the list mounts: "overdue" only has to be right when it is drawn.
const now = Date.now();
const cards = computed(() =>
	buildWorkCards({
		answer: props.answer,
		todo: props.todo,
		tasks: props.tasks,
		answerDueAt: text.answerDueAt,
		now,
	})
);
const isExpanded = ref(false);
const shown = computed(() => (isExpanded.value ? cards.value : cards.value.slice(0, SHOWN)));

// Colleagues write from the workspace's own domains: they are never a company.
const ownDomains = computed(
	() =>
		new Set(
			inboxes.value
				.map((inbox) => companyKeyOfDomain(inbox.address.split('@').pop() ?? ''))
				.filter((key): key is string => key !== null)
		)
);

function title(card: WorkCard): string {
	if (card.answer) return text.answerTitle(card.answer);
	if (card.todo) return text.todoTitle(card.todo);
	return card.task?.title ?? '';
}
function detail(card: WorkCard): string {
	if (card.answer) return text.answerDetail(card.answer);
	if (card.todo) return text.todoDetail(card.todo);
	return '';
}
function more(card: WorkCard): string {
	if (card.answer) return text.answerMore(card.answer);
	if (card.todo) return text.todoMore(card.todo);
	return '';
}
function meta(card: WorkCard): string {
	return card.answer ? text.answerMeta(card.answer) : '';
}

function companyOf(card: WorkCard): { key: string; name: string } | null {
	let key: string | null = null;
	if (card.task?.companyKey) key = card.task.companyKey;
	else if (card.answer?.source === 'mail')
		key = companyKeyOf(card.answer.row.fromAddress, ownDomains.value);
	else if (card.answer?.source === 'team') {
		key = companyKeyOf(parseFromHeader(card.answer.entry.message.from).address, ownDomains.value);
	} else if (card.todo) key = companyKeyOf(card.todo.fromAddress, ownDomains.value);
	return key ? { key, name: card.task?.companyName ?? companyNameFromKey(key) } : null;
}

function inboxOf(card: WorkCard): InboxIdentity<Id<'mailboxes'>> | null {
	if (!props.showInbox) return null;
	const id =
		card.answer?.source === 'mail'
			? card.answer.mailboxId
			: (card.todo?.mailboxId ??
				(card.task?.source?.kind === 'mail' ? card.task.source.mailboxId : null));
	return id ? (byId.value.get(id as Id<'mailboxes'>) ?? null) : null;
}

function focusHref(item: AnswerItem): string {
	const joiner = props.queueHref.includes('?') ? '&' : '?';
	return `${props.queueHref}${joiner}focus=${encodeURIComponent(item.id)}`;
}
/** Where the card's title goes: answering happens in the Answer queue, a request opens on its Overview. */
function href(card: WorkCard): string {
	if (card.answer) return focusHref(card.answer);
	if (card.todo) {
		return `/dashboard/postbox/inbox/${card.todo.messageId ?? ''}?mailbox=${card.todo.mailboxId}&view=overview`;
	}
	return `/dashboard/tasks?task=${card.task!._id}`;
}

function taskContext(card: WorkCard) {
	if (card.answer?.source === 'mail')
		return { mailThreadId: card.answer.row.threadId as Id<'mailThreads'> };
	if (card.answer?.source === 'team' && card.answer.entry.thread?._id) {
		return { conversationThreadId: card.answer.entry.thread._id };
	}
	if (card.todo) {
		return {
			mailThreadId: card.todo.threadId as Id<'mailThreads'>,
			threadItemId: card.todo.itemId as Id<'threadItems'>,
		};
	}
	return null;
}

function dueTone(at: number | null): string {
	if (at === null) return 'text-text-tertiary';
	const bucket = taskDueBucket(at, now);
	return bucket === 'overdue' || bucket === 'today'
		? 'font-medium text-error'
		: 'text-text-tertiary';
}

const say = (parts: SummaryPart[]) =>
	parts.map((part) => t(part.key, { count: part.count }, part.count)).join(' · ');
const effortLine = computed(() => say(answerEffortParts(props.counts, props.answer.length)));
</script>

<template>
	<section aria-labelledby="today-work" data-testid="today-work">
		<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
			<!-- The lane heading says it; this names the list for assistive tech. -->
			<h3 id="today-work" class="sr-only">
				{{ t('components.today.work.title') }}
			</h3>
			<UiButton
				v-if="answer.length > 0"
				:to="queueHref"
				size="sm"
				variant="secondary"
				class="ml-auto"
				data-testid="today-work-queue"
			>
				{{ t('components.today.work.workThrough', { count: answer.length }, answer.length) }}
				<span v-if="effortLine" class="font-normal text-text-tertiary">· {{ effortLine }}</span>
				<ArrowRightIcon class="size-3.5" aria-hidden="true" />
			</UiButton>
		</div>

		<div v-if="isLoading && cards.length === 0" class="space-y-2">
			<UiSkeleton class="h-16 w-full rounded-xl" />
			<UiSkeleton class="h-16 w-full rounded-xl" />
		</div>

		<div
			v-else-if="cards.length === 0"
			class="flex items-center gap-3 rounded-xl border border-dashed border-border-subtle px-4 py-5"
		>
			<CircleCheckIcon class="size-5 shrink-0 text-success" aria-hidden="true" />
			<div>
				<p class="text-sm font-medium text-text-primary">
					{{ t('components.today.work.clearTitle') }}
				</p>
				<p class="text-xs text-text-secondary">{{ t('components.today.work.clearBody') }}</p>
			</div>
		</div>

		<ul v-else class="space-y-2" data-testid="today-work-list">
			<li
				v-for="card in shown"
				:key="card.key"
				class="group rounded-xl border border-border-subtle bg-bg-elevated px-4 py-3 transition-colors focus-within:border-border-default hover:border-border-default"
				:data-work-kind="card.kind"
				data-testid="today-work-card"
			>
				<div class="flex items-start gap-3">
					<!-- The kind, at a glance: answer someone, do something, or a task to tick off. -->
					<button
						v-if="card.task"
						type="button"
						class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border-strong text-transparent transition-colors hover:border-brand hover:text-brand focus-visible:outline-2 focus-visible:outline-brand"
						:aria-label="t('components.today.work.complete', { title: card.task.title })"
						data-testid="today-work-complete"
						@click="setStatus(card.task, 'done')"
					>
						<CheckIcon class="size-3" aria-hidden="true" />
					</button>
					<span
						v-else
						class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full"
						:class="
							card.kind === 'reply'
								? 'bg-brand-soft text-brand'
								: 'bg-bg-surface text-text-secondary'
						"
						aria-hidden="true"
					>
						<ReplyIcon v-if="card.kind === 'reply'" class="size-3" />
						<FlagIcon v-else class="size-3" />
					</span>

					<div class="min-w-0 flex-1">
						<div class="flex min-w-0 items-baseline gap-2">
							<NuxtLink
								:to="href(card)"
								class="min-w-0 truncate text-sm font-medium text-text-primary outline-none hover:underline focus-visible:underline"
								data-testid="today-work-title"
							>
								{{ title(card) }}
							</NuxtLink>
							<span
								v-if="more(card)"
								class="shrink-0 rounded-full bg-brand-soft px-1.5 text-2xs font-medium text-brand"
								>{{ more(card) }}</span
							>
							<span
								v-if="card.dueAt !== null"
								class="ml-auto shrink-0 text-2xs"
								:class="dueTone(card.dueAt)"
								data-testid="today-work-due"
								>{{ text.dueLabel(card.dueAt) }}</span
							>
						</div>
						<div
							class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-tertiary"
						>
							<span v-if="detail(card)" class="min-w-0 truncate" data-testid="today-work-detail">{{
								detail(card)
							}}</span>
							<NuxtLink
								v-if="companyOf(card)"
								:to="`/dashboard/companies/${companyOf(card)!.key}`"
								class="inline-flex shrink-0 items-center gap-1 hover:text-text-primary hover:underline"
								data-testid="today-work-company"
							>
								<BriefcaseIcon class="size-3" aria-hidden="true" />{{ companyOf(card)!.name }}
							</NuxtLink>
							<InboxChip
								v-if="inboxOf(card)"
								:name="inboxOf(card)!.name"
								:slot="inboxOf(card)!.slot"
								:mark="inboxOf(card)!.mark ?? null"
								variant="plain"
							/>
							<span v-if="meta(card)" class="shrink-0">{{ meta(card) }}</span>
						</div>

						<CompanyTaskList
							v-if="card.tasks.length > 0"
							:tasks="card.tasks"
							compact
							class="mt-2 border-l-2 border-border-subtle pl-3"
						/>

						<div
							class="mt-2 flex flex-wrap items-center gap-1.5 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
						>
							<UiButton
								:to="href(card)"
								size="sm"
								:variant="card.kind === 'reply' ? 'primary' : 'secondary'"
							>
								{{
									card.kind === 'reply'
										? t('components.today.work.reply')
										: t('components.today.work.open')
								}}
							</UiButton>
							<TaskCreatePopover
								v-if="taskContext(card)"
								v-bind="taskContext(card)!"
								:default-title="title(card)"
								size="sm"
								variant="ghost"
							/>
						</div>
					</div>
				</div>
			</li>
		</ul>

		<button
			v-if="cards.length > SHOWN"
			type="button"
			class="mt-2 text-xs text-brand hover:underline"
			@click="isExpanded = !isExpanded"
		>
			{{
				isExpanded
					? t('components.today.work.showFewer')
					: t(
							'components.today.work.showMore',
							{ count: cards.length - SHOWN },
							cards.length - SHOWN
						)
			}}
		</button>
	</section>
</template>
