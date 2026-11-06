<script setup lang="ts">
/**
 * The Workbench's "Your tasks": the open tasks assigned to the viewer, soonest
 * due first, whichever inbox they came from. Tasks belong to a person, not to
 * an inbox, so every Workbench tab shows the same list.
 */
import { api } from '@owlat/api';
import CompanyTaskList from '~/components/companies/CompanyTaskList.vue';
import { CheckboxCheckedIcon } from '@coolicons/vue';

/** Enough to see what is next; the Tasks page has the rest. */
const SHOWN = 6;

const { t } = useI18n();
const { data, isLoading } = useConvexQuery(api.tasks.tasks.list, { view: 'mine' });
const tasks = computed(() => data.value ?? []);
const shown = computed(() => tasks.value.slice(0, SHOWN));

defineExpose({ count: computed(() => tasks.value.length) });
</script>

<template>
	<section aria-labelledby="today-my-tasks" class="mt-8">
		<h3
			id="today-my-tasks"
			class="mb-2 flex items-baseline gap-2 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
		>
			{{ t('components.today.myTasks.title') }}
			<span v-if="tasks.length > 0" class="tabular-nums">{{ tasks.length }}</span>
			<NuxtLink
				to="/dashboard/tasks"
				class="ml-auto normal-case tracking-normal text-text-secondary hover:text-text-primary"
			>
				{{ t('components.today.myTasks.all') }}
			</NuxtLink>
		</h3>

		<div v-if="isLoading && tasks.length === 0" class="space-y-2">
			<UiSkeleton class="h-10 w-full rounded-xl" />
		</div>
		<div
			v-else-if="tasks.length === 0"
			class="flex items-center gap-3 rounded-xl border border-dashed border-border-subtle px-4 py-4 text-sm text-text-secondary"
		>
			<CheckboxCheckedIcon class="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
			<span class="flex-1">{{ t('components.today.myTasks.empty') }}</span>
			<UiButton to="/dashboard/tasks?new=1" size="sm" variant="secondary">
				{{ t('components.today.myTasks.add') }}
			</UiButton>
		</div>
		<div v-else class="rounded-xl border border-border-subtle bg-bg-elevated px-4 py-2">
			<CompanyTaskList :tasks="shown" />
			<NuxtLink
				v-if="tasks.length > SHOWN"
				to="/dashboard/tasks"
				class="mt-1 block pb-1 text-xs text-brand hover:underline"
			>
				{{
					t('components.today.myTasks.more', { count: tasks.length - SHOWN }, tasks.length - SHOWN)
				}}
			</NuxtLink>
		</div>
	</section>
</template>
