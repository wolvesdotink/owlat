<script setup lang="ts">
// The contact page's delete confirmation. The page owns the delete itself.
defineProps<{
	/** What the body names the contact by: its address, else its name. */
	email?: string;
	isDeleting: boolean;
}>();

const emit = defineEmits<{ confirm: [] }>();

const showDeleteConfirm = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
</script>

<template>
	<UiConfirmationDialog
		v-model:open="showDeleteConfirm"
		variant="danger"
		:title="t('dashboard.audience.contacts.detail.deleteDialog.title')"
		:confirm-text="t('dashboard.audience.contacts.detail.deleteDialog.title')"
		:is-loading="isDeleting"
		@confirm="emit('confirm')"
	>
		<template #description>
			<I18nT
				keypath="dashboard.audience.contacts.detail.deleteDialog.body"
				tag="p"
				class="text-text-secondary"
				scope="global"
			>
				<template #email>
					<span class="font-medium text-text-primary break-all">{{
						email || t('dashboard.audience.contacts.detail.deleteDialog.thisContact')
					}}</span>
				</template>
			</I18nT>
		</template>
	</UiConfirmationDialog>
</template>
