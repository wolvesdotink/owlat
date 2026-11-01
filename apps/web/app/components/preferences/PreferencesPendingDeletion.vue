<script setup lang="ts">
import { formatDate } from '~/utils/formatters';

defineProps<{
	/** When the account is erased, epoch ms. */
	scheduledForDeletion: number | null;
	daysRemaining: number;
	isCancelling: boolean;
}>();

const emit = defineEmits<{ cancel: [] }>();

const { t } = useI18n();
</script>

<template>
	<div class="card p-0 overflow-hidden border-warning/30 bg-warning/5">
		<div class="px-6 py-4 border-b border-warning/20 bg-warning/10">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:alert-triangle" size="sm" variant="warning" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-warning">
						{{ t('dashboard.preferences.account.deletionPendingTitle') }}
					</h2>
					<p class="text-sm text-warning/80">
						{{ t('dashboard.preferences.account.deletionPendingSubtitle') }}
					</p>
				</div>
			</div>
		</div>

		<div class="p-6">
			<div class="flex items-center gap-6 mb-6">
				<div class="flex items-center gap-2 text-text-secondary">
					<Icon name="lucide:calendar" class="w-4 h-4" />
					<I18nT
						keypath="dashboard.preferences.account.deletionDate"
						tag="span"
						scope="global"
						class="text-sm"
					>
						<template #date>
							<strong class="text-text-primary">{{
								formatDate(scheduledForDeletion, 'full')
							}}</strong>
						</template>
					</I18nT>
				</div>
				<div class="px-3 py-1 rounded-full bg-warning/20 text-warning text-sm font-medium">
					{{ t('dashboard.preferences.account.daysRemaining', { days: daysRemaining }) }}
				</div>
			</div>

			<p class="text-text-secondary text-sm mb-6">
				{{ t('dashboard.preferences.account.deletionPendingBody') }}
			</p>

			<UiButton class="gap-2" :disabled="isCancelling" @click="emit('cancel')">
				<Icon
					v-if="isCancelling"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:x-circle" class="w-4 h-4" />
				{{
					isCancelling
						? t('dashboard.preferences.account.cancellingDeletion')
						: t('dashboard.preferences.account.cancelDeletionAction')
				}}
			</UiButton>
		</div>
	</div>
</template>
