<script setup lang="ts">
import { api } from '@owlat/api';
import { rules } from '~/composables/useFormValidation';

const { t } = useI18n();

useHead({ title: () => t('dashboard.inbox.codeTasks.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox.codeTasks',
});

const {
	data: tasks,
	isLoading,
	error,
} = useConvexQuery(api.codeWorkTasks.listRecent, () => ({ limit: 50 }));

// Manual code-task creation. The backend mutation (api.codeWorkTasks.create) is
// permission-gated on `organization:manage`; this is the admin UI for filing a
// task by hand instead of waiting for the inbox classifier to auto-create one.
const { run: createTask } = useBackendOperation(api.codeWorkTasks.create, {
	label: () => t('dashboard.inbox.codeTasks.createOperation'),
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
		// The messages resolve when the rule RUNS, not when the schema is built, so
		// a locale switch between mount and submit still validates in the active one.
		(value) => rules.required(t('dashboard.inbox.codeTasks.validation.descriptionRequired'))(value),
		(value) =>
			rules.minLength(10, t('dashboard.inbox.codeTasks.validation.descriptionTooShort'))(value),
	],
});

const handleCreate = async () => {
	if (!validation.validate(createForm)) return;

	createModal.setLoading(true);
	const result = await createTask({ description: createForm.description.trim() });
	createModal.setLoading(false);

	if (!result.ok) return; // run() already surfaced the failure

	createModal.close();
	showToast(t('dashboard.inbox.codeTasks.queuedToast'));
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
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.inbox.codeTasks.title') }}
					</h1>
					<p class="text-text-secondary mt-1">
						{{ t('dashboard.inbox.codeTasks.subtitle') }}
					</p>
				</div>
			</div>
			<UiButton class="gap-2 shrink-0" @click="createModal.open()">
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('dashboard.inbox.codeTasks.newTask') }}
			</UiButton>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">{{ t('dashboard.inbox.codeTasks.loading') }}</p>
			</div>
		</div>

		<!-- Error -->
		<UiErrorAlert
			v-else-if="error"
			:title="t('dashboard.inbox.codeTasks.errorTitle')"
			:message="t('dashboard.inbox.codeTasks.errorMessage')"
			class="my-8"
		/>

		<!-- Empty state -->
		<div
			v-else-if="!tasks || tasks.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:code-2" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">{{ t('dashboard.inbox.codeTasks.emptyTitle') }}</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.inbox.codeTasks.emptyBody') }}
			</p>
			<UiButton variant="secondary" class="gap-2 mt-4" @click="createModal.open()">
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('dashboard.inbox.codeTasks.newTask') }}
			</UiButton>
		</div>

		<!-- Task list -->
		<div v-else class="space-y-4">
			<CodeTasksCodeTaskCard v-for="task in tasks" :key="task._id" :task="task" />
		</div>

		<!-- Create modal -->
		<UiModal
			v-model:open="createModal.isOpen.value"
			:title="t('dashboard.inbox.codeTasks.newTask')"
		>
			<form @submit.prevent="handleCreate">
				<div class="space-y-4">
					<div>
						<label for="code-task-description" class="label">
							{{ t('common.description') }} <span class="text-error">*</span>
						</label>
						<textarea
							id="code-task-description"
							v-model="createForm.description"
							rows="5"
							:class="[
								'input w-full resize-y',
								validation.hasError('description') && 'input-error',
							]"
							:placeholder="t('dashboard.inbox.codeTasks.descriptionPlaceholder')"
							:disabled="createModal.isLoading.value"
							@blur="validation.touch('description')"
						/>
						<p v-if="validation.getError('description', true)" class="mt-1 text-xs text-error">
							{{ validation.getError('description', true) }}
						</p>
						<p v-else class="mt-1 text-xs text-text-tertiary">
							{{ t('dashboard.inbox.codeTasks.descriptionHint') }}
						</p>
					</div>
				</div>

				<div class="flex justify-end gap-3 mt-6">
					<UiButton
						variant="secondary"
						type="button"
						:disabled="createModal.isLoading.value"
						@click="createModal.close()"
					>
						{{ t('common.cancel') }}
					</UiButton>
					<UiButton type="submit" class="gap-2" :disabled="createModal.isLoading.value">
						<Icon
							v-if="createModal.isLoading.value"
							name="lucide:loader-2"
							class="w-4 h-4 animate-spin"
						/>
						<Icon v-else name="lucide:plus" class="w-4 h-4" />
						{{
							createModal.isLoading.value
								? t('dashboard.inbox.codeTasks.creating')
								: t('dashboard.inbox.codeTasks.create')
						}}
					</UiButton>
				</div>
			</form>
		</UiModal>
	</div>
</template>
