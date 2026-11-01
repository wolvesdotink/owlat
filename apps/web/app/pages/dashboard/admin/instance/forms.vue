<script setup lang="ts">
import AddEndpointModal from '~/components/forms/AddEndpointModal.vue';
import EditEndpointModal from '~/components/forms/EditEndpointModal.vue';
import EndpointDetails from '~/components/forms/EndpointDetails.vue';
import EndpointHeader from '~/components/forms/EndpointHeader.vue';
import { CodeIcon, FileTextIcon, PlusIcon } from '@coolicons/vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.forms.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

const {
	formsData,
	formsError,
	refetchForms,
	topicsData,
	isLoading,
	isAddModalOpen,
	addForm,
	addFormErrors,
	isAdding,
	resetAddForm,
	handleAddForm,
	addFieldEditor,
	formToEdit,
	editForm,
	editFormErrors,
	isSaving,
	openEditModal,
	handleSaveEdit,
	editFieldEditor,
	handleToggleActive,
	formToDelete,
	isDeleting,
	handleDeleteForm,
	expandedFormId,
	copiedCode,
	toggleFormExpansion,
	getFormUrl,
	getEmbedCode,
	copyToClipboard,
	getTopicName,
	formatDate,
} = useFormSettings();

const { hasActiveOrganization } = useOrganizationContext();

// ── Unsaved-changes guard ───────────────────────────────────────────
// Both form builders live in modals, so their drafts — a name, a topic, a
// redirect and a whole field list — exist only while the modal is up. A
// command-palette jump, a browser Back or a tab close must not throw all of it
// away without a word. Dirtiness is the draft measured against the snapshot
// taken when the modal opened, so opening a form just to read it never prompts.
const addSnapshot = ref('');
const editSnapshot = ref('');

watch(isAddModalOpen, (open) => {
	if (open) addSnapshot.value = JSON.stringify(addForm);
});
// `openEditModal` seeds `editForm` synchronously right after setting
// `formToEdit`, so by the time this callback runs the draft is the stored row.
watch(formToEdit, (form) => {
	if (form) editSnapshot.value = JSON.stringify(editForm);
});

const isAddDirty = computed(
	() => isAddModalOpen.value && JSON.stringify(addForm) !== addSnapshot.value
);
const isEditDirty = computed(
	() => formToEdit.value !== null && JSON.stringify(editForm) !== editSnapshot.value
);

const {
	showDialog: showUnsavedDialog,
	isSavingBeforeLeave,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	setHasChanges,
} = useUnsavedChanges({
	onSave: async () => {
		// Each handler clears its own modal only once the write lands, so a modal
		// still open means the save failed and the operator stays here.
		if (formToEdit.value) {
			await handleSaveEdit();
			if (formToEdit.value) throw new Error('Save failed');
			return;
		}
		await handleAddForm();
		if (isAddModalOpen.value) throw new Error('Save failed');
	},
});

watch([isAddDirty, isEditDirty], ([add, edit]) => setHasChanges(add || edit), { immediate: true });
</script>

<template>
	<div>
		<UiPageHeader
			:title="t('dashboard.admin.instance.forms.title')"
			:description="t('dashboard.admin.instance.forms.subtitle')"
			class="mb-6"
		>
			<template #actions>
				<UiButton class="gap-2" @click="isAddModalOpen = true">
					<PlusIcon class="w-4 h-4" />
					{{ t('dashboard.admin.instance.forms.newForm') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<!--
			First load: a content-shaped placeholder at the geometry of the form
			rows, rather than a centred spinner that blanks the page and then
			reflows. Same idiom the delivery list pages load with.
		-->
		<div
			v-if="isLoading && !formsData"
			class="card overflow-hidden"
			role="status"
			aria-busy="true"
			:aria-label="t('dashboard.admin.instance.forms.loading')"
		>
			<DashboardListSkeleton variant="card" leading :rows="3" />
		</div>

		<!-- No Organization State -->
		<div
			v-else-if="!hasActiveOrganization"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox :icon="FileTextIcon" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.admin.instance.forms.noWorkspaceTitle') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.admin.instance.forms.noWorkspaceBody') }}
			</p>
		</div>

		<!-- Content -->
		<div v-else class="space-y-8">
			<!-- Info Card -->
			<div class="card p-6 bg-brand/5 border-brand/20">
				<div class="flex gap-4">
					<UiIconBox :icon="CodeIcon" size="sm" variant="brand" rounded="lg" />
					<div>
						<h3 class="font-medium text-text-primary mb-1">
							{{ t('dashboard.admin.instance.forms.infoTitle') }}
						</h3>
						<p class="text-sm text-text-secondary">
							{{ t('dashboard.admin.instance.forms.infoBody') }}
						</p>
					</div>
				</div>
			</div>

			<!-- A failed read is not an empty list. -->
			<UiQueryBoundary v-if="formsError" :error="formsError" @retry="refetchForms" />

			<!-- Empty State -->
			<div
				v-else-if="formsData && formsData.length === 0"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox :icon="FileTextIcon" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">
					{{ t('dashboard.admin.instance.forms.emptyTitle') }}
				</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					{{ t('dashboard.admin.instance.forms.emptyBody') }}
				</p>
				<UiButton class="gap-2 mt-4" @click="isAddModalOpen = true">
					<PlusIcon class="w-4 h-4" />
					{{ t('dashboard.admin.instance.forms.createFirst') }}
				</UiButton>
			</div>

			<!-- Forms List -->
			<div v-else-if="formsData && formsData.length > 0" class="space-y-4">
				<div v-for="form in formsData" :key="form._id" class="card p-0 overflow-hidden">
					<!-- Form Header -->
					<EndpointHeader
						:form="form"
						:topic-name="getTopicName(form.topicId)"
						:created-on="formatDate(form.createdAt)"
						:expanded="expandedFormId === form._id"
						@toggle="toggleFormExpansion(form._id)"
						@toggle-active="handleToggleActive(form)"
						@edit="openEditModal(form as Parameters<typeof openEditModal>[0])"
						@delete="
							formToDelete = {
								_id: form._id,
								name: form.name,
								totalSubmissions: form.totalSubmissions,
							}
						"
					/>

					<!-- Expanded Content (Embed Code & Stats) -->
					<Transition name="expand">
						<EndpointDetails
							v-if="expandedFormId === form._id"
							:form="form"
							:form-url="getFormUrl(form._id)"
							:embed-code="getEmbedCode(form)"
							:copied-code="copiedCode"
							@copy="copyToClipboard"
						/>
					</Transition>
				</div>
			</div>
		</div>

		<!-- Add Form Modal -->
		<AddEndpointModal
			:open="isAddModalOpen"
			:form="addForm"
			:errors="addFormErrors"
			:is-adding="isAdding"
			:topics="topicsData"
			:field-editor="addFieldEditor"
			@close="isAddModalOpen = false"
			@cancel="
				isAddModalOpen = false;
				resetAddForm();
			"
			@submit="handleAddForm"
		/>

		<!-- Edit Form Modal -->
		<EditEndpointModal
			:open="!!formToEdit"
			:form="editForm"
			:errors="editFormErrors"
			:is-saving="isSaving"
			:topics="topicsData"
			:field-editor="editFieldEditor"
			@close="formToEdit = null"
			@submit="handleSaveEdit"
		/>

		<!-- Delete Form Confirmation Modal -->
		<UiConfirmationDialog
			:open="!!formToDelete"
			variant="danger"
			:title="t('dashboard.admin.instance.forms.deleteModal.title')"
			:description="
				t('dashboard.admin.instance.forms.deleteModal.description', {
					name: formToDelete?.name ?? '',
				})
			"
			:confirm-text="t('dashboard.admin.instance.forms.deleteModal.confirm')"
			:is-loading="isDeleting"
			@update:open="
				(v: boolean) => {
					if (!v) formToDelete = null;
				}
			"
			@confirm="handleDeleteForm"
		>
			<p v-if="formToDelete && formToDelete.totalSubmissions > 0" class="mt-2 text-sm text-warning">
				{{
					t('dashboard.admin.instance.forms.deleteModal.records', {
						count: formToDelete.totalSubmissions,
					})
				}}
			</p>
			<p class="mt-2 text-sm text-text-tertiary">
				{{ t('dashboard.admin.instance.forms.deleteModal.irreversible') }}
			</p>
		</UiConfirmationDialog>

		<!-- Unsaved Changes Dialog -->
		<UiUnsavedChangesDialog
			:show="showUnsavedDialog"
			:saving="isSavingBeforeLeave"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>
	</div>
</template>

<style scoped>
.expand-enter-active,
.expand-leave-active {
	transition-property: opacity, max-height;
	transition-duration: var(--motion-moderate);
	transition-timing-function: var(--ease-spring);
	overflow: hidden;
}
.expand-enter-from,
.expand-leave-to {
	opacity: 0;
	max-height: 0;
}
.expand-enter-to,
.expand-leave-from {
	max-height: 1500px;
}
</style>
