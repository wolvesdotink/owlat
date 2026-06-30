<script setup lang="ts">
import { api } from '@owlat/api';
import { rules } from '~/composables/useFormValidation';

useHead({ title: 'Code Tasks — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox.codeTasks',
});

const { data: tasks, isLoading, error } = useConvexQuery(
	api.codeWorkTasks.listRecent,
	() => ({ limit: 50 }),
);

// Manual code-task creation. The backend mutation (api.codeWorkTasks.create) is
// permission-gated on `organization:manage`; this is the admin UI for filing a
// task by hand instead of waiting for the inbox classifier to auto-create one.
const { run: createTask } = useBackendOperation(api.codeWorkTasks.create, {
	label: 'Create code task',
});
const { showToast } = useToast();

const createModal = useModal({
	onClose: () => {
		createForm.description = '';
		validation.reset();
	},
});

const createForm = reactive({
	description: '',
});

const validation = useFormValidation({
	description: [
		rules.required('Describe the feature request or fix'),
		rules.minLength(10, 'Add a little more detail (at least 10 characters)'),
	],
});

const handleCreate = async () => {
	if (!validation.validate(createForm)) return;

	createModal.setLoading(true);
	const result = await createTask({ description: createForm.description.trim() });
	createModal.setLoading(false);

	if (result === undefined) return; // run() already surfaced the failure

	createModal.close();
	showToast('Code task queued. The coding agent will pick it up shortly.');
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex items-start justify-between gap-4 mb-8">
			<div class="flex items-center gap-4">
				<NuxtLink
					to="/dashboard/inbox"
					class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
				>
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
				</NuxtLink>
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Code Tasks</h1>
					<p class="text-text-secondary mt-1">
						Code tasks: feature requests, bug fixes, and improvements tracked from request through merge.
					</p>
				</div>
			</div>
			<button class="btn btn-primary gap-2 shrink-0" @click="createModal.open()">
				<Icon name="lucide:plus" class="w-4 h-4" />
				New code task
			</button>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading code tasks...</p>
			</div>
		</div>

		<!-- Error -->
		<UiErrorAlert
			v-else-if="error"
			title="Couldn't load code tasks"
			message="We hit an error loading code tasks. Reload the page to try again."
			class="my-8"
		/>

		<!-- Empty state -->
		<div
			v-else-if="!tasks || tasks.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:code-2" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No code tasks yet</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Code tasks appear here when the AI agent files feature requests or fixes — or
				you can create one by hand.
			</p>
			<button class="btn btn-secondary gap-2 mt-4" @click="createModal.open()">
				<Icon name="lucide:plus" class="w-4 h-4" />
				New code task
			</button>
		</div>

		<!-- Task list -->
		<div v-else class="space-y-4">
			<CodeTasksCodeTaskCard
				v-for="task in tasks"
				:key="task._id"
				:task="task"
			/>
		</div>

		<!-- Create modal -->
		<UiModal v-model:open="createModal.isOpen.value" title="New code task">
			<form @submit.prevent="handleCreate">
				<div class="space-y-4">
					<div>
						<label for="code-task-description" class="label">
							Description <span class="text-error">*</span>
						</label>
						<textarea
							id="code-task-description"
							v-model="createForm.description"
							rows="5"
							:class="['input w-full resize-y', validation.hasError('description') && 'input-error']"
							placeholder="Describe the feature request or fix for the coding agent, e.g. &quot;Add a CSV export button to the contacts list.&quot;"
							:disabled="createModal.isLoading.value"
							@blur="validation.touch('description')"
						/>
						<p v-if="validation.getError('description', true)" class="mt-1 text-xs text-error">
							{{ validation.getError('description', true) }}
						</p>
						<p v-else class="mt-1 text-xs text-text-tertiary">
							The coding agent will turn this into a branch, write the code and open a pull request.
						</p>
					</div>
				</div>

				<div class="flex justify-end gap-3 mt-6">
					<button
						type="button"
						class="btn btn-secondary"
						:disabled="createModal.isLoading.value"
						@click="createModal.close()"
					>
						Cancel
					</button>
					<button type="submit" class="btn btn-primary gap-2" :disabled="createModal.isLoading.value">
						<Icon
							v-if="createModal.isLoading.value"
							name="lucide:loader-2"
							class="w-4 h-4 animate-spin"
						/>
						<Icon v-else name="lucide:plus" class="w-4 h-4" />
						{{ createModal.isLoading.value ? 'Creating...' : 'Create code task' }}
					</button>
				</div>
			</form>
		</UiModal>
	</div>
</template>
