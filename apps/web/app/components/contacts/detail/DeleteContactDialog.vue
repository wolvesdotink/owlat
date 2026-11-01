<script setup lang="ts">
// The contact page's delete confirmation. The page owns the delete itself.
import { TrashIcon } from '@coolicons/vue';

defineProps<{
	email?: string;
	isDeleting: boolean;
}>();

const emit = defineEmits<{ confirm: [] }>();

const showDeleteConfirm = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
</script>

<template>
	<Teleport to="body">
		<Transition
			enter-active-class="duration-(--motion-moderate) ease-spring"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="duration-(--motion-moderate-exit) ease-exit"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div v-if="showDeleteConfirm" class="fixed inset-0 z-50 flex items-center justify-center p-4">
				<!-- Backdrop -->
				<div class="absolute inset-0 bg-scrim/60" @click="showDeleteConfirm = false" />

				<!-- Modal -->
				<div
					class="relative bg-bg-elevated border border-border-subtle rounded-2xl p-6 w-full max-w-md"
				>
					<div class="flex items-center gap-4 mb-4">
						<div class="p-3 rounded-full bg-error-subtle flex items-center justify-center">
							<TrashIcon class="w-6 h-6 text-error" />
						</div>
						<div>
							<h3 class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.audience.contacts.detail.deleteDialog.title') }}
							</h3>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.audience.contacts.detail.deleteDialog.subtitle') }}
							</p>
						</div>
					</div>

					<I18nT
						keypath="dashboard.audience.contacts.detail.deleteDialog.body"
						tag="p"
						class="text-text-secondary mb-6"
						scope="global"
					>
						<template #email>
							<span class="font-medium text-text-primary">{{ email }}</span>
						</template>
					</I18nT>

					<div class="flex items-center justify-end gap-3">
						<UiButton variant="secondary" :disabled="isDeleting" @click="showDeleteConfirm = false">
							{{ t('common.cancel') }}
						</UiButton>
						<UiButton variant="danger" :disabled="isDeleting" @click="emit('confirm')">
							<UiSpinner v-if="isDeleting" class="mr-2" size="xs" tone="inverse" />
							{{
								isDeleting
									? t('dashboard.audience.contacts.detail.deleting')
									: t('dashboard.audience.contacts.detail.deleteDialog.title')
							}}
						</UiButton>
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
