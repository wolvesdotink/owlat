<script setup lang="ts">
/**
 * One task in a list: its checkbox, title and the facts that matter at a
 * glance (who sees it, the company, the conversation it came from, when it is
 * due, who owns it, who handed it over). Pressing the row opens the task;
 * the chips that are links go where they say.
 *
 * The row itself is the keyboard focus target for the page's j/k, Enter and
 * x keys (`data-task-id`), so it takes focus but sits outside the Tab order;
 * Tab reaches its checkbox and title instead.
 */
import {
	CalendarIcon,
	ChatIcon,
	CheckIcon,
	FactoryIcon,
	LockIcon,
	MailIcon,
	UsersGroupIcon,
	UsersIcon,
} from '@coolicons/vue';
import type { TaskMember, TaskView } from '~/types/tasks';
import { taskSourceHref } from '~/utils/taskAudience';
import { taskDayOffset, taskDueBucket } from '~/utils/taskBuckets';

const props = defineProps<{
	task: TaskView;
	viewerId: string | null;
	/** The assignee, when the roster knows them. */
	assignee: TaskMember | null;
	assigneeName: string;
	creatorName: string;
	selected: boolean;
	now: number;
}>();
const emit = defineEmits<{ toggle: []; open: [] }>();

const { t, locale } = useI18n();

const isFinished = computed(() => props.task.status !== 'open');
const isMine = computed(() => props.task.assigneeUserId === props.viewerId);
const fromSomeoneElse = computed(() => props.task.createdBy !== props.viewerId);

const audienceChip = computed(() => {
	switch (props.task.visibility) {
		case 'private':
			return { icon: LockIcon, label: t('components.tasks.audience.privateChip') };
		case 'everyone':
			return { icon: UsersIcon, label: t('components.tasks.audience.everyone') };
		case 'group':
			return {
				icon: UsersGroupIcon,
				label: props.task.groupName ?? t('components.tasks.audience.unknownGroup'),
			};
	}
	return null;
});

const sourceHref = computed(() => taskSourceHref(props.task.source));
const sourceChip = computed(() => {
	const source = props.task.source;
	if (!source) return null;
	const fallback =
		source.kind === 'mail'
			? t('components.tasks.source.fromEmail')
			: t('components.tasks.source.fromTeamInbox');
	return {
		icon: source.kind === 'mail' ? MailIcon : ChatIcon,
		label: source.canOpen && source.subject ? source.subject : fallback,
		title: fallback,
	};
});

const due = computed(() => {
	const at = props.task.dueAt;
	if (at === null) return null;
	const offset = taskDayOffset(at, props.now);
	const label =
		offset === 0
			? t('components.tasks.due.today')
			: offset === 1
				? t('components.tasks.due.tomorrow')
				: offset === -1
					? t('components.tasks.due.yesterday')
					: formatShortDate(at, locale.value);
	const bucket = isFinished.value ? 'later' : taskDueBucket(at, props.now);
	return {
		label,
		tone:
			bucket === 'overdue'
				? 'text-error'
				: bucket === 'today'
					? 'text-warning'
					: 'text-text-tertiary',
		overdue: bucket === 'overdue',
	};
});

/** A press on the row's empty space opens it; its own buttons and links keep theirs. */
function onRowClick(event: MouseEvent) {
	if ((event.target as HTMLElement).closest('a, button, input')) return;
	emit('open');
}
</script>

<template>
	<li
		:data-task-id="task._id"
		tabindex="-1"
		class="group flex items-start gap-3 px-4 py-2.5 transition-colors outline-none focus-visible:bg-bg-surface focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40"
		:class="selected ? 'bg-(--surface-2-selected)' : 'hover:bg-bg-surface'"
		@click="onRowClick"
	>
		<button
			type="button"
			role="checkbox"
			:aria-checked="isFinished"
			:aria-label="
				isFinished
					? t('components.tasks.row.reopen', { title: task.title })
					: t('components.tasks.row.complete', { title: task.title })
			"
			class="mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-brand"
			:class="
				task.status === 'dropped'
					? 'border-border-strong bg-bg-surface text-transparent hover:border-brand hover:text-brand'
					: isFinished
						? 'border-brand bg-brand text-text-inverse'
						: 'border-border-strong text-transparent hover:border-brand hover:text-brand'
			"
			data-testid="task-toggle"
			@click="emit('toggle')"
		>
			<CheckIcon class="size-3" aria-hidden="true" />
		</button>
		<div class="min-w-0 flex-1">
			<button
				type="button"
				class="block max-w-full truncate text-left text-sm focus-visible:outline-2 focus-visible:outline-brand"
				:class="isFinished ? 'text-text-tertiary line-through' : 'font-medium text-text-primary'"
				data-testid="task-open"
				@click="emit('open')"
			>
				{{ task.title }}
			</button>
			<div
				class="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-2xs text-text-tertiary"
			>
				<span
					v-if="task.status === 'dropped'"
					class="rounded-full bg-bg-surface px-1.5 py-px font-medium text-text-secondary"
					data-testid="task-dropped"
				>
					{{ t('components.tasks.row.dropped') }}
				</span>
				<span
					v-if="audienceChip"
					class="inline-flex items-center gap-1"
					data-testid="task-audience"
				>
					<component :is="audienceChip.icon" class="size-3" aria-hidden="true" />
					{{ audienceChip.label }}
				</span>
				<NuxtLink
					v-if="task.companyKey"
					:to="`/dashboard/companies/${task.companyKey}`"
					class="inline-flex max-w-40 items-center gap-1 hover:text-text-primary hover:underline"
				>
					<FactoryIcon class="size-3 shrink-0" aria-hidden="true" />
					<span class="truncate">{{ task.companyName ?? task.companyKey }}</span>
				</NuxtLink>
				<template v-if="sourceChip">
					<!-- native-title: the full subject of a chip that truncates it -->
					<NuxtLink
						v-if="sourceHref"
						:to="sourceHref"
						:title="sourceChip.title"
						class="inline-flex max-w-56 items-center gap-1 hover:text-text-primary hover:underline"
					>
						<component :is="sourceChip.icon" class="size-3 shrink-0" aria-hidden="true" />
						<span class="truncate">{{ sourceChip.label }}</span>
					</NuxtLink>
					<span v-else class="inline-flex items-center gap-1">
						<component :is="sourceChip.icon" class="size-3 shrink-0" aria-hidden="true" />
						{{ sourceChip.label }}
					</span>
				</template>
				<span v-if="fromSomeoneElse" data-testid="task-from">
					{{ t('components.tasks.row.from', { name: creatorName }) }}
				</span>
			</div>
		</div>
		<span
			v-if="due"
			class="mt-0.5 inline-flex shrink-0 items-center gap-1 text-2xs font-medium"
			:class="due.tone"
			data-testid="task-due"
		>
			<CalendarIcon class="size-3" aria-hidden="true" />
			<span v-if="due.overdue" class="sr-only">{{ t('components.tasks.due.overdue') }}</span>
			{{ due.label }}
		</span>
		<span
			v-if="!isMine"
			class="shrink-0"
			:title="t('components.tasks.row.assignedTo', { name: assigneeName })"
		>
			<UiAvatar
				:name="assignee?.name ?? assigneeName"
				:email="assignee?.email ?? null"
				:image="assignee?.image ?? null"
				deterministic-color
				size="xs"
			/>
			<span class="sr-only">{{
				t('components.tasks.row.assignedTo', { name: assigneeName })
			}}</span>
		</span>
	</li>
</template>
