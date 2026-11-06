<script setup lang="ts">
/**
 * Tasks: the things to do that conversations bring, and the ones added by
 * hand. One list at a time (Mine, Everyone, each of the viewer's groups,
 * Private, Handed off, Done), named in the URL (`?view=`, `?group=`), with a
 * quick add on top and the open task in a panel beside the list (`?task=`).
 *
 * Open lists are grouped by when they are due, Done by when the task was
 * finished (utils/taskBuckets.ts). Ticking a task takes it out of the list at
 * once and offers Undo.
 *
 * Keys, in the `tasks` shortcut scope: j/k move between tasks, Enter opens
 * one, x or Space ticks it, c goes to quick add, Esc closes the panel.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { UiTabOption } from '@owlat/ui/utils/tabs';
import { CircleCheckIcon, ListChecklistIcon, PlusIcon } from '@coolicons/vue';
import TaskAudiencePicker from '~/components/tasks/TaskAudiencePicker.vue';
import TaskAssigneePicker from '~/components/tasks/TaskAssigneePicker.vue';
import TaskDetailPanel from '~/components/tasks/TaskDetailPanel.vue';
import TaskRow from '~/components/tasks/TaskRow.vue';
import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';
import { useShortcutScope } from '~/composables/useShortcutScope';
import type { TaskStatus, TaskView } from '~/types/tasks';
import {
	parseTaskPageView,
	taskDefaultAudience,
	taskPageViewKey,
	taskShowsInView,
	type TaskPageView,
} from '~/utils/taskAudience';
import { groupTasksByCompletion, groupTasksByDue } from '~/utils/taskBuckets';

definePageMeta({ layout: 'dashboard', middleware: 'auth' });

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { showToast } = useToast();

useHead({ title: () => t('dashboard.tasks.pageTitle') });

// ── Which list ─────────────────────────────────────────────────────────────
const pageView = computed(() => parseTaskPageView(route.query['view'], route.query['group']));
const viewKey = computed(() => taskPageViewKey(pageView.value));
const isDoneView = computed(() => pageView.value.view === 'done');

const draft = useTaskDraft({ initialAudience: () => taskDefaultAudience(pageView.value) });
const { people } = draft;
const { title: draftTitle, audience: draftAudience, assigneeUserId, dueInput } = draft;
const memberGroups = computed(() => people.groups.value.filter((group) => group.isMember));
const viewedGroup = computed(() =>
	pageView.value.view === 'group'
		? (people.groups.value.find((group) => group._id === pageView.value.groupId) ?? null)
		: null
);

const { count: openCount } = useTaskOpenCount();
const tabs = computed<UiTabOption[]>(() => [
	{
		value: 'mine',
		label: t('dashboard.tasks.views.mine'),
		...(openCount.value ? { count: openCount.value } : {}),
	},
	{ value: 'everyone', label: t('dashboard.tasks.views.everyone') },
	...memberGroups.value.map((group) => ({ value: `group:${group._id}`, label: group.name })),
	{ value: 'private', label: t('dashboard.tasks.views.private') },
	{ value: 'created', label: t('dashboard.tasks.views.created') },
	{ value: 'done', label: t('dashboard.tasks.views.done') },
]);

function selectTab(value: string) {
	const { view: _view, group: _group, task: _task, ...rest } = route.query;
	const query = value.startsWith('group:')
		? { ...rest, view: 'group', group: value.slice('group:'.length) }
		: value === 'mine'
			? rest
			: { ...rest, view: value };
	void router.replace({ query });
}

// ── The list ───────────────────────────────────────────────────────────────
const list = useConvexQuery(api.tasks.tasks.list, () =>
	pageView.value.view === 'group' && pageView.value.groupId
		? { view: 'group' as const, groupId: pageView.value.groupId }
		: { view: pageView.value.view }
);

// Rows taken out at once by a tick; the live list confirms, Undo brings them back.
const hidden = ref(new Set<string>());
watch(viewKey, () => (hidden.value = new Set()));
const tasks = computed(() => (list.data.value ?? []).filter((task) => !hidden.value.has(task._id)));

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
	clock = setInterval(() => (now.value = Date.now()), 60_000);
});
onBeforeUnmount(() => {
	if (clock) clearInterval(clock);
});

const sections = computed(() =>
	isDoneView.value
		? groupTasksByCompletion(tasks.value, now.value).map((group) => ({
				key: group.bucket,
				label: t(`dashboard.tasks.doneBuckets.${group.bucket}`),
				tasks: group.tasks,
			}))
		: groupTasksByDue(tasks.value, now.value).map((group) => ({
				key: group.bucket,
				label: t(`dashboard.tasks.dueBuckets.${group.bucket}`),
				tasks: group.tasks,
			}))
);

const emptyState = computed(() => {
	const view = pageView.value.view;
	const group = viewedGroup.value?.name ?? t('components.tasks.audience.unknownGroup');
	return {
		title: t(`dashboard.tasks.empty.${view}.title`, { group }),
		description: t(`dashboard.tasks.empty.${view}.body`, { group }),
	};
});

function assigneeOf(task: TaskView) {
	return people.byId.value.get(task.assigneeUserId) ?? null;
}

// ── Status changes ─────────────────────────────────────────────────────────
function leavesList(next: TaskStatus): boolean {
	return isDoneView.value ? next === 'open' : next !== 'open';
}
const actions = useTaskActions({
	hide: (id, next) => {
		if (leavesList(next)) hidden.value = new Set([...hidden.value, id]);
	},
	unhide: (id) => {
		const next = new Set(hidden.value);
		next.delete(id);
		hidden.value = next;
	},
});
function toggle(task: TaskView) {
	void actions.toggleDone(task);
}
function changeStatus(task: TaskView, status: TaskStatus) {
	void actions.setStatus(task, status);
}

// ── Quick add ──────────────────────────────────────────────────────────────
const quickInput = ref<HTMLInputElement | null>(null);
const quickDueId = useId();
watch(pageView, (view: TaskPageView) => {
	draftAudience.value = taskDefaultAudience(view);
});

async function add() {
	const audience = draftAudience.value;
	const assignee = assigneeUserId.value;
	const id = await draft.create();
	if (!id) return;
	draft.resetForNext();
	quickInput.value?.focus();
	const viewer = people.viewerId.value;
	if (viewer && !taskShowsInView(pageView.value, audience, assignee || viewer, viewer)) {
		showToast(t('dashboard.tasks.addedElsewhere'), 'success', {
			action: { label: t('common.open'), onAction: () => openTask(id) },
		});
	}
}

function focusQuickAdd() {
	quickInput.value?.focus();
}
// The command palette's "New task" lands here with `?new=1`.
onMounted(() => {
	if (route.query['new'] === undefined) return;
	const { new: _new, ...rest } = route.query;
	void router.replace({ query: rest });
	void nextTick(focusQuickAdd);
});

// ── The open task (state in the URL) ───────────────────────────────────────
const selectedId = computed(() => {
	const raw = route.query['task'];
	return typeof raw === 'string' && raw ? (raw as Id<'tasks'>) : null;
});
const selected = useConvexQuery(api.tasks.tasks.get, () =>
	selectedId.value ? { taskId: selectedId.value } : 'skip'
);
const selectedTask = computed(() =>
	selected.data.value && selected.data.value._id === selectedId.value ? selected.data.value : null
);

function openTask(id: Id<'tasks'>) {
	if (selectedId.value === id) return;
	const query = { ...route.query, task: id };
	void (selectedId.value ? router.replace({ query }) : router.push({ query }));
}
function closeTask() {
	const id = selectedId.value;
	const { task: _task, ...rest } = route.query;
	void router.push({ query: rest });
	if (id) void nextTick(() => rowElement(id)?.focus());
}

// ── Keyboard ───────────────────────────────────────────────────────────────
useShortcutScope('tasks');
const { registerShortcut } = useKeyboardShortcuts();
const listRef = ref<HTMLElement | null>(null);
const rows = () => Array.from(listRef.value?.querySelectorAll<HTMLElement>('[data-task-id]') ?? []);
const rowElement = (id: string) => rows().find((row) => row.dataset['taskId'] === id) ?? null;
/** The row the keyboard is on: the focused one, else the open task's. */
const activeRow = () =>
	(document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-task-id]') ??
	(selectedId.value ? rowElement(selectedId.value) : null);
const focusedRowTask = () => {
	const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
		'[data-task-id]'
	);
	return row ? (tasks.value.find((task) => task._id === row.dataset['taskId']) ?? null) : null;
};

function move(delta: 1 | -1) {
	const all = rows();
	const active = activeRow();
	const index = active ? all.indexOf(active) : -1;
	const next = all[delta === 1 ? Math.min(all.length - 1, index + 1) : Math.max(0, index - 1)];
	if (!next) return;
	next.focus();
	// With the panel open, moving also opens the next task in it.
	if (selectedId.value && next.dataset['taskId']) openTask(next.dataset['taskId'] as Id<'tasks'>);
}

registerShortcut({ id: 'tasks.next', handler: () => move(1), when: () => rows().length > 0 });
registerShortcut({ id: 'tasks.previous', handler: () => move(-1), when: () => rows().length > 0 });
registerShortcut({
	id: 'tasks.open',
	handler: () => {
		const task = focusedRowTask();
		if (task) openTask(task._id);
	},
	when: () => focusedRowTask() !== null,
});
registerShortcut({
	id: 'tasks.toggleDone',
	handler: () => {
		const task = focusedRowTask();
		if (!task) return;
		const all = rows();
		const row = rowElement(task._id);
		const index = row ? all.indexOf(row) : -1;
		(all[index + 1] ?? all[index - 1])?.focus();
		toggle(task);
	},
	when: () => focusedRowTask() !== null,
});
registerShortcut({ id: 'tasks.newTask', handler: focusQuickAdd });
</script>

<template>
	<div class="mx-auto w-full max-w-4xl px-6 pb-16 pt-8 lg:px-10">
		<UiPageHeader
			:title="t('dashboard.tasks.title')"
			:description="t('dashboard.tasks.subtitle')"
		/>

		<div class="mt-6">
			<UiTabs
				:tabs="tabs"
				:model-value="viewKey"
				panel-id="tasks-panel"
				@update:model-value="selectTab"
			/>
		</div>

		<form
			class="mt-4 rounded-xl border border-border-subtle bg-bg-elevated"
			data-testid="task-quick-add"
			@submit.prevent="add"
		>
			<div class="flex items-center gap-2 px-4 py-2">
				<PlusIcon class="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
				<label for="task-quick-add-title" class="sr-only">{{
					t('components.tasks.fields.title')
				}}</label>
				<input
					id="task-quick-add-title"
					ref="quickInput"
					v-model="draftTitle"
					type="text"
					maxlength="300"
					autocomplete="off"
					class="input-bare min-w-0 flex-1 py-1 text-sm text-text-primary placeholder:text-text-tertiary"
					:placeholder="t('dashboard.tasks.quickAdd.placeholder')"
					data-testid="task-quick-add-title"
				/>
				<UiButton
					size="sm"
					type="submit"
					:disabled="!draft.canCreate.value"
					:loading="draft.isCreating.value"
				>
					{{ t('dashboard.tasks.quickAdd.submit') }}
				</UiButton>
			</div>
			<div
				class="flex flex-wrap items-start gap-x-5 gap-y-2 border-t border-border-subtle px-4 py-2.5"
			>
				<TaskAudiencePicker v-model="draftAudience" :groups="draft.groups.value" />
				<TaskAssigneePicker
					v-model="assigneeUserId"
					:options="draft.assigneeOptions.value"
					:viewer-id="people.viewerId.value"
					:fallback-name="people.nameOf(assigneeUserId)"
					:disabled-reason="draft.assigneeDisabledReason.value"
				/>
				<div class="flex items-center gap-1.5">
					<label :for="quickDueId" class="text-xs text-text-tertiary">{{
						t('components.tasks.fields.due')
					}}</label>
					<input :id="quickDueId" v-model="dueInput" type="date" class="input input-sm w-36" />
				</div>
			</div>
		</form>

		<div
			id="tasks-panel"
			ref="listRef"
			role="tabpanel"
			:aria-label="tabs.find((tab) => tab.value === viewKey)?.label"
			class="mt-6"
		>
			<UiQueryBoundary
				v-if="list.error.value && !list.data.value"
				:error="list.error.value"
				@retry="list.refetch"
			/>
			<div v-else-if="list.isLoading.value && !list.data.value" class="space-y-2">
				<UiSkeleton class="h-3 w-24" />
				<UiSkeleton class="h-32 w-full rounded-xl" />
			</div>
			<UiEmptyState
				v-else-if="sections.length === 0"
				:title="emptyState.title"
				:description="emptyState.description"
				:icon="isDoneView ? CircleCheckIcon : ListChecklistIcon"
				:heading-level="2"
				data-testid="tasks-empty"
			/>
			<template v-else>
				<section
					v-for="section in sections"
					:key="section.key"
					:aria-labelledby="`tasks-bucket-${section.key}`"
					class="mb-6"
					:data-testid="`tasks-bucket-${section.key}`"
				>
					<h2
						:id="`tasks-bucket-${section.key}`"
						class="mb-2 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider"
						:class="section.key === 'overdue' ? 'text-error' : 'text-text-tertiary'"
					>
						{{ section.label }}
						<span class="font-normal tabular-nums">{{ section.tasks.length }}</span>
					</h2>
					<ul
						class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
					>
						<TaskRow
							v-for="task in section.tasks"
							:key="task._id"
							:task="task"
							:viewer-id="people.viewerId.value"
							:assignee="assigneeOf(task)"
							:assignee-name="people.nameOf(task.assigneeUserId)"
							:creator-name="people.nameOf(task.createdBy)"
							:selected="task._id === selectedId"
							:now="now"
							@toggle="toggle(task)"
							@open="openTask(task._id)"
						/>
					</ul>
				</section>
			</template>
		</div>

		<TaskDetailPanel
			:open="selectedId !== null"
			:task="selectedTask"
			:is-loading="selected.isLoading.value"
			@close="closeTask"
			@status="changeStatus"
		/>
	</div>
</template>
