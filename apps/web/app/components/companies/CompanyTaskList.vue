<script setup lang="ts">
/**
 * Tasks as a checklist, for the company page and the panel beside a
 * conversation. Ticking a box finishes the task and offers Undo; unticking a
 * finished one reopens it. The title opens the task on the Tasks page.
 *
 * The box shows the asked-for state while the write is in flight, so a tick
 * does not bounce back for a round trip. The write and its Undo toast are the
 * Tasks page's own (useTaskActions), so a task reads the same wherever it is
 * ticked off.
 */
import { useTaskActions } from '~/composables/useTaskActions';
import type { TaskView } from '~/types/tasks';
import { taskAudienceLabel } from '~/utils/companies';
import { briefDueDate } from '~/utils/threadBriefContext';
import { taskDueBucket } from '~/utils/taskBuckets';
import { LockIcon, UsersGroupIcon, UsersIcon } from '@coolicons/vue';

defineProps<{
	tasks: readonly TaskView[];
	/** Smaller rows for the panel beside a conversation. */
	compact?: boolean;
}>();

const { t, locale } = useI18n();
// Read when the list mounts, so a list left open across midnight marks
// yesterday's tasks overdue only once it is shown again.
const now = Date.now();
const { setStatus } = useTaskActions();

const pending = ref(new Map<string, 'open' | 'done'>());

function isChecked(task: TaskView): boolean {
	const asked = pending.value.get(task._id);
	return asked ? asked === 'done' : task.status !== 'open';
}

async function toggle(task: TaskView, checked: boolean) {
	const next = checked ? 'done' : 'open';
	pending.value = new Map(pending.value).set(task._id, next);
	await setStatus(task, next);
	const rest = new Map(pending.value);
	rest.delete(task._id);
	pending.value = rest;
}

function audienceText(task: TaskView): string {
	const label = taskAudienceLabel(task);
	return 'key' in label ? t(label.key) : label.text;
}

function audienceIcon(task: TaskView) {
	if (task.visibility === 'private') return LockIcon;
	if (task.visibility === 'group') return UsersGroupIcon;
	return UsersIcon;
}
</script>

<template>
	<ul class="space-y-0.5" data-testid="company-task-list">
		<li
			v-for="task in tasks"
			:key="task._id"
			class="group flex items-start gap-2.5 rounded-md -mx-1.5 px-1.5 hover:bg-bg-surface"
			:class="compact ? 'py-1' : 'py-1.5'"
			data-testid="company-task"
		>
			<input
				type="checkbox"
				class="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border-default bg-bg-deep text-brand focus:ring-brand focus:ring-offset-0"
				:checked="isChecked(task)"
				:aria-label="
					isChecked(task)
						? t('components.companies.tasks.reopen', { title: task.title })
						: t('components.companies.tasks.complete', { title: task.title })
				"
				@change="toggle(task, ($event.target as HTMLInputElement).checked)"
			/>
			<span class="min-w-0 flex-1">
				<NuxtLink
					:to="`/dashboard/tasks?task=${task._id}`"
					class="block text-sm text-text-primary hover:underline focus-visible:underline outline-none"
					:class="{ 'text-text-tertiary line-through': isChecked(task), truncate: compact }"
				>
					{{ task.title }}
				</NuxtLink>
				<span class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-text-tertiary">
					<span class="inline-flex items-center gap-1" data-testid="company-task-audience">
						<component :is="audienceIcon(task)" class="h-3.5 w-3.5" aria-hidden="true" />
						{{ audienceText(task) }}
					</span>
					<span
						v-if="task.dueAt !== null"
						:class="{
							'font-medium text-error':
								task.status === 'open' && taskDueBucket(task.dueAt, now) === 'overdue',
						}"
					>
						{{ t('components.companies.tasks.due', { date: briefDueDate(task.dueAt, locale) }) }}
					</span>
				</span>
			</span>
		</li>
	</ul>
</template>
