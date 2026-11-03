<script setup lang="ts">
// The campaign editor's action row: Cancel, Save draft, Schedule / Reschedule
// and Send now. On a phone the three send actions take their own line
// (wrapping, right-aligned) instead of squeezing every label onto two lines and
// pushing Send now past the edge.
import { ClockIcon, PaperPlaneIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

defineProps<{
	isDraft: boolean;
	isScheduled: boolean;
	isSaving: boolean;
	canSchedule: boolean;
}>();

const emit = defineEmits<{ back: []; save: []; schedule: []; sendNow: [] }>();

const { t } = useI18n();
</script>

<template>
	<div class="flex flex-wrap items-center justify-between gap-3 pt-4">
		<UiButton variant="secondary" type="button" @click="emit('back')">
			{{ t('common.cancel') }}
		</UiButton>
		<div class="flex flex-wrap items-center justify-end gap-3 ml-auto">
			<!-- Save button for draft campaigns -->
			<UiButton
				variant="secondary"
				v-if="isDraft"
				class="gap-2"
				:disabled="isSaving"
				@click="emit('save')"
			>
				<SpinnerIcon v-if="isSaving" class="w-4 h-4" />
				{{ t('dashboard.campaigns.detail.edit.actions.saveDraft') }}
			</UiButton>

			<!-- Schedule button -->
			<UiButton
				variant="secondary"
				class="gap-2"
				:disabled="isSaving || !canSchedule"
				@click="emit('schedule')"
			>
				<SpinnerIcon v-if="isSaving" class="w-4 h-4" />
				<ClockIcon v-else class="w-4 h-4" />
				{{
					isScheduled
						? t('dashboard.campaigns.detail.edit.actions.reschedule')
						: t('dashboard.campaigns.detail.edit.actions.schedule')
				}}
			</UiButton>

			<!-- Send Now button -->
			<UiButton class="gap-2" :disabled="isSaving" @click="emit('sendNow')">
				<SpinnerIcon v-if="isSaving" class="w-4 h-4" />
				<PaperPlaneIcon v-else class="w-4 h-4" />
				{{ t('dashboard.campaigns.detail.edit.actions.sendNow') }}
			</UiButton>
		</div>
	</div>
</template>
