<script setup lang="ts">
/**
 * One task, opened beside its list (a sheet over the page on a narrow
 * screen). Everything about it can be changed here: title, notes, who sees
 * it, who owns it, the due date and the company. Each field saves on its own
 * when it loses focus or is picked.
 *
 * The status actions have their way back: Done and Drop on an open task,
 * Reopen on a done one, Restore on a dropped one. Escape or Back closes the
 * panel; the list underneath stays put.
 */
import { api } from '@owlat/api';
import {
	ArrowLeftIcon,
	ChatIcon,
	CloseIcon,
	ExternalLinkIcon,
	MailIcon,
	ReplyIcon,
} from '@coolicons/vue';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { useEscapeLayer } from '@owlat/ui/composables/useEscapeLayer';
import TaskAudiencePicker from '~/components/tasks/TaskAudiencePicker.vue';
import TaskAssigneePicker from '~/components/tasks/TaskAssigneePicker.vue';
import type { TaskAudience, TaskStatus, TaskView } from '~/types/tasks';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import {
	sameTaskAudience,
	taskAssigneeAfterAudience,
	taskAssigneeOptions,
	taskAudienceGroups,
	taskAudienceOf,
	taskMayBecomePrivate,
	taskSourceHref,
} from '~/utils/taskAudience';
import { taskDueFromDateInput, taskDueToDateInput } from '~/utils/taskBuckets';

const props = defineProps<{
	open: boolean;
	task: TaskView | null;
	isLoading: boolean;
}>();
const emit = defineEmits<{ close: []; status: [task: TaskView, status: TaskStatus] }>();

const { t, locale } = useI18n();
const people = useTaskPeople();

const { run: runUpdate } = useBackendOperation(api.tasks.mutations.update, {
	label: () => t('components.tasks.operations.update'),
});

const titleId = useId();
const notesId = useId();
const companyId = useId();
const dueId = useId();
const titleDraft = ref('');
const notesDraft = ref('');
const companyDraft = ref('');
const dueDraft = ref('');
watch(
	() => props.task,
	(task, previous) => {
		if (!task) return;
		// Keep what the person is typing when the same task updates underneath.
		const same = previous?._id === task._id;
		if (!same || document.activeElement?.id !== titleId) titleDraft.value = task.title;
		if (!same || document.activeElement?.id !== notesId) notesDraft.value = task.notes ?? '';
		if (!same || document.activeElement?.id !== companyId)
			companyDraft.value = task.companyKey ?? '';
		dueDraft.value = taskDueToDateInput(task.dueAt);
	},
	{ immediate: true }
);

const audience = computed(() => (props.task ? taskAudienceOf(props.task) : null));
const audienceGroups = computed(() =>
	taskAudienceGroups(people.groups.value, audience.value ?? undefined)
);
const privateReason = computed(() =>
	props.task && !taskMayBecomePrivate(props.task, people.viewerId.value)
		? t('components.tasks.detail.privateReason')
		: null
);
const assigneeOptions = computed(() =>
	audience.value
		? taskAssigneeOptions(
				audience.value,
				people.members.value,
				people.groups.value,
				people.viewerId.value
			)
		: []
);
const assigneeReason = computed(() =>
	audience.value?.visibility === 'private' ? t('components.tasks.assignee.privateReason') : null
);

async function save(patch: Omit<Parameters<typeof runUpdate>[0], 'taskId'>) {
	if (!props.task) return false;
	return (await runUpdate({ taskId: props.task._id, ...patch })).ok;
}

function saveTitle() {
	const task = props.task;
	const next = titleDraft.value.trim();
	if (!task) return;
	if (!next) {
		titleDraft.value = task.title;
		return;
	}
	if (next !== task.title) void save({ title: next });
}
function saveNotes() {
	const task = props.task;
	if (!task) return;
	const next = notesDraft.value.trim();
	if (next !== (task.notes ?? '')) void save({ notes: next || null });
}
function saveCompany() {
	const task = props.task;
	if (!task) return;
	const next = companyDraft.value.trim().toLowerCase();
	if (next === (task.companyKey ?? '')) return;
	void save({ companyKey: next || null }).then((ok) => {
		if (!ok) companyDraft.value = task.companyKey ?? '';
	});
}
function clearCompany() {
	companyDraft.value = '';
	saveCompany();
}
function saveDue() {
	const task = props.task;
	if (!task) return;
	const next = taskDueFromDateInput(dueDraft.value);
	if (next === task.dueAt) return;
	// Same day, different stored moment (an older task): nothing to change.
	if (next !== null && task.dueAt !== null && taskDueToDateInput(task.dueAt) === dueDraft.value)
		return;
	void save({ dueAt: next });
}
function setAudience(next: TaskAudience) {
	const task = props.task;
	const viewer = people.viewerId.value;
	if (!task || !viewer || (audience.value && sameTaskAudience(next, audience.value))) return;
	const assignee = taskAssigneeAfterAudience(
		next,
		task.assigneeUserId,
		people.members.value,
		people.groups.value,
		viewer
	);
	void save({
		visibility: next.visibility,
		groupId: next.visibility === 'group' ? next.groupId : null,
		...(assignee !== task.assigneeUserId ? { assigneeUserId: assignee } : {}),
	});
}
function setAssignee(userId: string) {
	if (props.task && userId !== props.task.assigneeUserId) void save({ assigneeUserId: userId });
}

const sourceHref = computed(() => taskSourceHref(props.task?.source ?? null));

// Doing the work often means telling them: Answer mode on the conversation the
// task came from, with the reply composer open. Finishing the task stays its own step.
const answerNav = useAnswerModeNav();
const canReplyAbout = computed(() => {
	const source = props.task?.source;
	if (!source?.canOpen || props.task?.status !== 'open') return false;
	return source.kind === 'team' || !!source.messageId;
});
function replyAbout() {
	const source = props.task?.source;
	if (!source?.canOpen) return;
	if (source.kind === 'team') void answerNav.openTeam(source.conversationThreadId);
	else if (source.messageId) void answerNav.open(source.messageId);
}
const sourceLabel = computed(() => {
	const source = props.task?.source;
	if (!source) return '';
	if (!source.canOpen) return t('components.tasks.detail.sourceClosed');
	return (
		source.subject ||
		(source.kind === 'mail'
			? t('components.tasks.source.fromEmail')
			: t('components.tasks.source.fromTeamInbox'))
	);
});

const statusLine = computed(() => {
	const task = props.task;
	if (!task || task.status === 'open') return '';
	const who = task.completedBy ? people.nameOf(task.completedBy) : '';
	const when = task.completedAt ? formatShortDate(task.completedAt, locale.value) : '';
	return task.status === 'done'
		? t('components.tasks.detail.doneBy', { name: who, date: when })
		: t('components.tasks.detail.droppedBy', { name: who, date: when });
});
const createdLine = computed(() => {
	const task = props.task;
	if (!task) return '';
	return t('components.tasks.detail.createdBy', {
		name:
			task.createdBy === people.viewerId.value
				? t('components.tasks.assignee.you')
				: people.nameOf(task.createdBy),
		date: formatShortDate(task.createdAt, locale.value),
	});
});

useEscapeLayer(
	() => props.open,
	(event) => {
		if (isEditableTarget(event.target)) return false;
		emit('close');
	}
);
const panelRef = ref<HTMLElement | null>(null);
watch(
	() => props.open,
	async (open, was) => {
		if (open && !was) {
			await nextTick();
			panelRef.value?.focus();
		}
	}
);
</script>

<template>
	<Transition
		enter-active-class="transition duration-(--motion-moderate) ease-(--ease-spring)"
		enter-from-class="translate-x-4 opacity-0"
		leave-active-class="transition duration-(--motion-moderate-exit)"
		leave-to-class="translate-x-4 opacity-0"
	>
		<aside
			v-if="open"
			ref="panelRef"
			tabindex="-1"
			role="dialog"
			:aria-label="task?.title || t('components.tasks.detail.label')"
			class="fixed bottom-0 right-0 top-[calc(var(--titlebar-h,0px)+var(--shell-chrome-h,4rem))] z-30 flex w-full max-w-md flex-col border-l border-border-subtle bg-bg-elevated shadow-(--shadow-6) outline-none"
			data-testid="task-detail"
		>
			<header
				class="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5 text-xs text-text-tertiary"
			>
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-bg-surface hover:text-text-primary"
					@click="emit('close')"
				>
					<ArrowLeftIcon class="size-3.5" aria-hidden="true" />
					{{ t('components.tasks.detail.back') }}
					<kbd class="font-mono text-2xs">Esc</kbd>
				</button>
			</header>

			<div v-if="isLoading && !task" class="space-y-3 p-5">
				<UiSkeleton class="h-5 w-3/4" />
				<UiSkeleton class="h-3 w-1/2" />
				<UiSkeleton class="h-24 w-full" />
			</div>
			<div v-else-if="!task" class="p-5 text-sm text-text-secondary">
				{{ t('components.tasks.detail.gone') }}
			</div>
			<div v-else class="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
				<div>
					<label :for="titleId" class="sr-only">{{ t('components.tasks.fields.title') }}</label>
					<!-- The title edits in place; the wrapper draws its field only on
					     hover and focus, so it reads as a heading until then. -->
					<div
						class="rounded-md border border-transparent px-1 py-0.5 hover:border-border-subtle focus-within:border-border-default"
					>
						<input
							:id="titleId"
							v-model="titleDraft"
							type="text"
							maxlength="300"
							class="input-bare w-full text-base font-medium text-text-primary"
							:class="task.status !== 'open' ? 'text-text-tertiary line-through' : ''"
							data-testid="task-detail-title"
							@blur="saveTitle"
							@keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
						/>
					</div>
					<p class="mt-1 px-1 text-xs text-text-tertiary">{{ createdLine }}</p>
					<p v-if="statusLine" class="mt-0.5 px-1 text-xs text-text-tertiary">{{ statusLine }}</p>
				</div>

				<div class="space-y-1.5">
					<label
						:for="notesId"
						class="block text-2xs font-medium uppercase tracking-wider text-text-tertiary"
					>
						{{ t('components.tasks.fields.notes') }}
					</label>
					<textarea
						:id="notesId"
						v-model="notesDraft"
						rows="4"
						maxlength="5000"
						class="input input-sm w-full resize-y"
						:placeholder="t('components.tasks.fields.notesPlaceholder')"
						@blur="saveNotes"
					/>
				</div>

				<div class="space-y-1.5">
					<p class="text-2xs font-medium uppercase tracking-wider text-text-tertiary">
						{{ t('components.tasks.fields.audience') }}
					</p>
					<TaskAudiencePicker
						v-if="audience"
						:model-value="audience"
						:groups="audienceGroups"
						:private-disabled-reason="privateReason"
						@update:model-value="setAudience"
					/>
				</div>

				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div class="space-y-1.5">
						<p class="text-2xs font-medium uppercase tracking-wider text-text-tertiary">
							{{ t('components.tasks.fields.assignee') }}
						</p>
						<TaskAssigneePicker
							:model-value="task.assigneeUserId"
							:options="assigneeOptions"
							:viewer-id="people.viewerId.value"
							:fallback-name="people.nameOf(task.assigneeUserId)"
							:disabled-reason="assigneeReason"
							@update:model-value="setAssignee"
						/>
					</div>
					<div class="space-y-1.5">
						<label
							:for="dueId"
							class="block text-2xs font-medium uppercase tracking-wider text-text-tertiary"
						>
							{{ t('components.tasks.fields.due') }}
						</label>
						<input
							:id="dueId"
							v-model="dueDraft"
							type="date"
							class="input input-sm w-full"
							@change="saveDue"
						/>
					</div>
				</div>

				<div class="space-y-1.5">
					<label
						:for="companyId"
						class="block text-2xs font-medium uppercase tracking-wider text-text-tertiary"
					>
						{{ t('components.tasks.fields.company') }}
					</label>
					<div class="flex items-center gap-2">
						<input
							:id="companyId"
							v-model="companyDraft"
							type="text"
							class="input input-sm min-w-0 flex-1"
							:placeholder="t('components.tasks.fields.companyPlaceholder')"
							@blur="saveCompany"
							@keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
						/>
						<UiButton
							v-if="task.companyKey"
							size="sm"
							variant="ghost"
							:aria-label="t('components.tasks.detail.clearCompany')"
							@click="clearCompany"
						>
							<CloseIcon class="size-3.5" aria-hidden="true" />
						</UiButton>
					</div>
					<NuxtLink
						v-if="task.companyKey"
						:to="`/dashboard/companies/${task.companyKey}`"
						class="inline-flex items-center gap-1 text-xs text-brand hover:underline"
					>
						{{
							t('components.tasks.detail.openCompany', {
								name: task.companyName ?? task.companyKey,
							})
						}}
					</NuxtLink>
				</div>

				<div v-if="task.source" class="space-y-1.5">
					<p class="text-2xs font-medium uppercase tracking-wider text-text-tertiary">
						{{ t('components.tasks.fields.source') }}
					</p>
					<NuxtLink
						v-if="sourceHref"
						:to="sourceHref"
						class="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-primary transition-colors hover:bg-bg-surface"
						data-testid="task-detail-source"
					>
						<component
							:is="task.source.kind === 'mail' ? MailIcon : ChatIcon"
							class="size-4 shrink-0 text-text-tertiary"
							aria-hidden="true"
						/>
						<span class="min-w-0 flex-1 truncate">{{ sourceLabel }}</span>
						<ExternalLinkIcon class="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
					</NuxtLink>
					<p
						v-else
						class="flex items-center gap-2 rounded-lg border border-dashed border-border-subtle px-3 py-2 text-sm text-text-secondary"
						data-testid="task-detail-source"
					>
						<component
							:is="task.source.kind === 'mail' ? MailIcon : ChatIcon"
							class="size-4 shrink-0 text-text-tertiary"
							aria-hidden="true"
						/>
						{{ sourceLabel }}
					</p>
					<UiButton
						v-if="canReplyAbout"
						size="sm"
						variant="secondary"
						data-testid="task-detail-reply"
						@click="replyAbout"
					>
						<ReplyIcon class="size-3.5" aria-hidden="true" />
						{{ t('components.tasks.detail.replyAbout') }}
					</UiButton>
				</div>
			</div>

			<footer v-if="task" class="flex items-center gap-2 border-t border-border-subtle px-5 py-3">
				<template v-if="task.status === 'open'">
					<UiButton size="sm" data-testid="task-detail-done" @click="emit('status', task, 'done')">
						{{ t('components.tasks.detail.done') }}
					</UiButton>
					<UiButton
						size="sm"
						variant="secondary"
						data-testid="task-detail-drop"
						@click="emit('status', task, 'dropped')"
					>
						{{ t('components.tasks.detail.drop') }}
					</UiButton>
				</template>
				<UiButton
					v-else-if="task.status === 'done'"
					size="sm"
					variant="secondary"
					data-testid="task-detail-reopen"
					@click="emit('status', task, 'open')"
				>
					{{ t('components.tasks.detail.reopen') }}
				</UiButton>
				<UiButton
					v-else
					size="sm"
					variant="secondary"
					data-testid="task-detail-restore"
					@click="emit('status', task, 'open')"
				>
					{{ t('components.tasks.detail.restore') }}
				</UiButton>
			</footer>
		</aside>
	</Transition>
</template>
