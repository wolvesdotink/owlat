<script setup lang="ts">
// The contact page's header: who it is, the double-opt-in status, and the
// edit / resend / export / delete actions. The page owns every action.
import {
	DownloadIcon,
	MailIcon,
	PencilIcon,
	SaveIcon,
	TrashIcon,
	UserIcon,
	type IconComponent,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

defineProps<{
	title: string;
	email?: string;
	doiStatus?: string;
	doiLabel: string;
	doiColor: string;
	doiIcon: IconComponent | null;
	isEditing: boolean;
	isSaving: boolean;
	canManage: boolean;
	isResendingDoi: boolean;
	exporting: boolean;
}>();

const emit = defineEmits<{
	cancel: [];
	save: [];
	edit: [];
	'resend-doi': [];
	export: [];
	delete: [];
}>();

const { t } = useI18n();
</script>

<template>
	<div class="flex items-start gap-4 mb-8">
		<UiIconBox :icon="UserIcon" size="xl" variant="surface" rounded="full" />
		<UiPageHeader class="flex-1" :title="title" :description="email">
			<!-- Double-opt-in confirmation status -->
			<template v-if="doiLabel" #meta>
				<div class="inline-flex items-center gap-1.5 text-sm" :class="doiColor">
					<component v-if="doiIcon" :is="doiIcon" class="w-4 h-4" />
					<span>{{ doiLabel }}</span>
				</div>
			</template>

			<template #actions>
				<template v-if="isEditing">
					<UiButton variant="ghost" :disabled="isSaving" @click="emit('cancel')">
						{{ t('common.cancel') }}
					</UiButton>
					<UiButton class="gap-2" :disabled="isSaving" @click="emit('save')">
						<UiSpinner v-if="isSaving" size="xs" tone="inverse" />
						<SaveIcon v-else class="w-4 h-4" />
						{{ t('dashboard.audience.contacts.detail.saveChanges') }}
					</UiButton>
				</template>
				<template v-else-if="canManage">
					<UiTooltip
						v-if="doiStatus === 'pending'"
						:text="t('dashboard.audience.contacts.detail.resendDoiTitle')"
					>
						<UiButton
							variant="secondary"
							class="gap-2"
							:disabled="isResendingDoi"
							@click="emit('resend-doi')"
						>
							<SpinnerIcon v-if="isResendingDoi" class="w-4 h-4" />
							<MailIcon v-else class="w-4 h-4" />
							{{
								isResendingDoi
									? t('dashboard.audience.contacts.detail.sending')
									: t('dashboard.audience.contacts.detail.resendDoi')
							}}
						</UiButton>
					</UiTooltip>
					<UiButton variant="secondary" class="gap-2" @click="emit('edit')">
						<PencilIcon class="w-4 h-4" />
						{{ t('common.edit') }}
					</UiButton>
					<UiTooltip :text="t('dashboard.audience.contacts.detail.exportDataTitle')">
						<UiButton
							variant="secondary"
							class="gap-2"
							:disabled="exporting"
							@click="emit('export')"
						>
							<DownloadIcon class="w-4 h-4" />
							{{
								exporting
									? t('dashboard.audience.contacts.detail.exporting')
									: t('dashboard.audience.contacts.detail.exportData')
							}}
						</UiButton>
					</UiTooltip>
					<UiButton
						variant="ghost"
						class="text-error hover:bg-error-subtle"
						@click="emit('delete')"
						:aria-label="t('common.delete')"
					>
						<TrashIcon class="w-4 h-4" />
					</UiButton>
				</template>
			</template>
		</UiPageHeader>
	</div>
</template>
