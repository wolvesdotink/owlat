<script setup lang="ts">
/**
 * "Make task": a button that opens a small form for a new task, for any
 * surface that has something to do in it (a conversation, a company). The
 * task is tied to whatever the props name: a Postbox thread, a Team Inbox
 * thread, one item of it, a company. The backend fills in the conversation's
 * company when none is given.
 *
 * The form starts as Only me, assigned to the viewer, with `defaultTitle` as
 * its title. On success it emits `created` and shows a toast that opens the
 * task on the Tasks page.
 */
import type { Id } from '@owlat/api/dataModel';
import { ListChecklistIcon } from '@coolicons/vue';
import TaskAudiencePicker from '~/components/tasks/TaskAudiencePicker.vue';
import TaskAssigneePicker from '~/components/tasks/TaskAssigneePicker.vue';
import { TASK_PRIVATE_AUDIENCE } from '~/utils/taskAudience';

const props = withDefaults(
	defineProps<{
		mailThreadId?: Id<'mailThreads'>;
		conversationThreadId?: Id<'conversationThreads'>;
		threadItemId?: Id<'threadItems'>;
		companyKey?: string;
		defaultTitle?: string;
		/** The trigger's text; "Make task" when not given. */
		label?: string;
		size?: 'sm' | 'md';
		variant?: 'secondary' | 'ghost';
	}>(),
	{
		mailThreadId: undefined,
		conversationThreadId: undefined,
		threadItemId: undefined,
		companyKey: undefined,
		defaultTitle: '',
		label: undefined,
		size: 'sm',
		variant: 'secondary',
	}
);
const emit = defineEmits<{ created: [taskId: Id<'tasks'>] }>();

const { t } = useI18n();
const { showToast } = useToast();
const draft = useTaskDraft();
const { title, audience, assigneeUserId, dueInput } = draft;

/** Open from outside too (the command palette); the trigger toggles it as well. */
const open = defineModel<boolean>('open', { default: false });
const titleId = useId();
const dueId = useId();
const triggerLabel = computed(() => props.label ?? t('components.tasks.create.trigger'));

watch(open, (isOpen) => {
	if (!isOpen) return;
	title.value = props.defaultTitle;
	dueInput.value = '';
	audience.value = TASK_PRIVATE_AUDIENCE;
	void nextTick(() => {
		const input = document.getElementById(titleId) as HTMLInputElement | null;
		input?.focus();
		input?.select();
	});
});

async function submit() {
	const id = await draft.create({
		...(props.mailThreadId ? { mailThreadId: props.mailThreadId } : {}),
		...(props.conversationThreadId ? { conversationThreadId: props.conversationThreadId } : {}),
		...(props.threadItemId ? { threadItemId: props.threadItemId } : {}),
		...(props.companyKey ? { companyKey: props.companyKey } : {}),
	});
	if (!id) return;
	open.value = false;
	draft.resetForNext();
	emit('created', id);
	showToast(t('components.tasks.create.created'), 'success', {
		action: {
			label: t('components.tasks.create.open'),
			onAction: () => void navigateTo(`/dashboard/tasks?task=${id}`),
		},
	});
}
</script>

<template>
	<UiPopover v-model:open="open" align="end" :label="t('components.tasks.create.title')">
		<template #trigger>
			<UiButton :variant="variant" :size="size" data-testid="task-create-trigger">
				<template #iconLeft>
					<ListChecklistIcon class="size-4" aria-hidden="true" />
				</template>
				{{ triggerLabel }}
			</UiButton>
		</template>

		<form class="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-3" @submit.prevent="submit">
			<h2 class="text-sm font-medium text-text-primary">
				{{ t('components.tasks.create.title') }}
			</h2>
			<div>
				<label :for="titleId" class="sr-only">{{ t('components.tasks.fields.title') }}</label>
				<input
					:id="titleId"
					v-model="title"
					type="text"
					class="input input-sm w-full"
					:placeholder="t('components.tasks.fields.titlePlaceholder')"
					maxlength="300"
					data-testid="task-create-title"
				/>
			</div>
			<div class="space-y-1">
				<p class="text-2xs font-medium uppercase tracking-wider text-text-tertiary">
					{{ t('components.tasks.fields.audience') }}
				</p>
				<TaskAudiencePicker v-model="audience" :groups="draft.groups.value" />
			</div>
			<div class="flex flex-wrap items-start gap-3">
				<div class="min-w-0 flex-1 space-y-1">
					<p class="text-2xs font-medium uppercase tracking-wider text-text-tertiary">
						{{ t('components.tasks.fields.assignee') }}
					</p>
					<TaskAssigneePicker
						v-model="assigneeUserId"
						:options="draft.assigneeOptions.value"
						:viewer-id="draft.people.viewerId.value"
						:fallback-name="draft.people.nameOf(assigneeUserId)"
						:disabled-reason="draft.assigneeDisabledReason.value"
					/>
				</div>
				<div class="space-y-1">
					<label
						:for="dueId"
						class="block text-2xs font-medium uppercase tracking-wider text-text-tertiary"
						>{{ t('components.tasks.fields.due') }}</label
					>
					<input
						:id="dueId"
						v-model="dueInput"
						type="date"
						class="input input-sm w-36"
						data-testid="task-create-due"
					/>
				</div>
			</div>
			<div class="flex justify-end gap-2 pt-1">
				<UiButton size="sm" variant="ghost" @click="open = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					size="sm"
					type="submit"
					:disabled="!draft.canCreate.value"
					:loading="draft.isCreating.value"
					data-testid="task-create-submit"
				>
					{{ t('components.tasks.create.submit') }}
				</UiButton>
			</div>
		</form>
	</UiPopover>
</template>
