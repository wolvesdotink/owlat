<script setup lang="ts">
import { api } from '@owlat/api';
import { TrashIcon, TriangleWarningIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	/** BetterAuth user id of the account being deleted. */
	userId: string | null;
}>();

const open = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
const { showToast: showNotification } = useToast();

const deleteReason = ref('');
const deleteConfirmText = ref('');
const isDeleting = ref(false);

const { run: requestDeletion } = useBackendOperation(
	api.auth.accountManagement.requestAccountDeletion,
	{
		label: () => t('dashboard.preferences.account.requestDeletionOperation'),
	}
);

// Request account deletion
const handleDeleteAccount = async () => {
	if (!props.userId) return;
	if (deleteConfirmText.value !== 'DELETE') return;

	isDeleting.value = true;

	const result = await requestDeletion({
		userId: props.userId,
		reason: deleteReason.value || undefined,
	});
	isDeleting.value = false;

	if (!result.ok) return;

	// The backend requestAccountDeletion mutation schedules the confirmation
	// email (internal.auth.accountDeletionEmail.sendAccountDeletionEmail) before it
	// returns, so the copy below can promise it.
	showNotification(t('dashboard.preferences.account.deletionRequested'));
	open.value = false;
	deleteReason.value = '';
	deleteConfirmText.value = '';

	// `result.result` carries the scheduledForDeletion timestamp; nothing else to do
	// here — the confirmation email is already scheduled by the mutation above.
	void result.result;
};
</script>

<template>
	<UiModal
		:open="open"
		size="lg"
		:closable="!isDeleting"
		:persistent="isDeleting"
		@update:open="
			(v) => {
				if (!v) open = false;
			}
		"
	>
		<!-- Header -->
		<div class="flex items-center gap-3 mb-6">
			<UiIconBox :icon="TriangleWarningIcon" size="sm" variant="error" rounded="lg" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('dashboard.preferences.account.deleteModalTitle') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.preferences.account.deleteModalSubtitle') }}
				</p>
			</div>
		</div>

		<!-- Content -->
		<div class="p-4 rounded-xl bg-error/5 border border-error/20 mb-6">
			<I18nT
				keypath="dashboard.preferences.account.deleteModalWarning"
				tag="p"
				scope="global"
				class="text-sm text-error"
			>
				<template #warning>
					<strong>{{ t('dashboard.preferences.account.warningLabel') }}</strong>
				</template>
			</I18nT>
		</div>

		<!-- Optional reason -->
		<div class="mb-6">
			<label class="label" for="delete-reason">
				{{ t('dashboard.preferences.account.reasonLabel') }}
			</label>
			<textarea
				id="delete-reason"
				v-model="deleteReason"
				class="input min-h-[100px] resize-none"
				:placeholder="t('dashboard.preferences.account.reasonPlaceholder')"
			/>
		</div>

		<!-- Confirmation input -->
		<div>
			<I18nT
				keypath="dashboard.preferences.account.confirmDeleteLabel"
				tag="label"
				scope="global"
				class="label"
				for="confirm-delete"
			>
				<template #word><strong class="text-error">DELETE</strong></template>
			</I18nT>
			<input
				id="confirm-delete"
				v-model="deleteConfirmText"
				type="text"
				class="input"
				placeholder="DELETE"
				autocomplete="off"
			/>
		</div>

		<template #footer>
			<UiButton variant="ghost" type="button" :disabled="isDeleting" @click="open = false">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton
				variant="danger"
				type="button"
				class="gap-2"
				:disabled="isDeleting || deleteConfirmText !== 'DELETE'"
				@click="handleDeleteAccount"
			>
				<SpinnerIcon v-if="isDeleting" class="w-4 h-4" />
				<TrashIcon v-else class="w-4 h-4" />
				{{
					isDeleting
						? t('dashboard.preferences.account.processing')
						: t('dashboard.preferences.account.deleteMyAccount')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
