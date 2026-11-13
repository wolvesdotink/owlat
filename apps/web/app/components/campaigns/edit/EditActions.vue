<script setup lang="ts">
// The campaign editor's action row: Cancel, Save draft, Schedule / Reschedule
// and Send now. On a phone the three send actions take their own line
// (wrapping, right-aligned) instead of squeezing every label onto two lines and
// pushing Send now past the edge.
import { ClockIcon, PaperPlaneIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	isDraft: boolean;
	isScheduled: boolean;
	isSaving: boolean;
	canSchedule: boolean;
}>();

const emit = defineEmits<{ back: []; save: []; schedule: []; sendNow: [] }>();

const { t } = useI18n();

// The three actions share one saving flag, so the spinner goes on the one that
// was pressed; the others are only disabled.
type Action = 'save' | 'schedule' | 'sendNow';
const pressed = ref<Action | null>(null);
const press = (action: Action) => {
	pressed.value = action;
	if (action === 'save') emit('save');
	else if (action === 'schedule') emit('schedule');
	else emit('sendNow');
};
watch(
	() => props.isSaving,
	(saving) => {
		if (!saving) pressed.value = null;
	}
);
const spinning = (action: Action) => props.isSaving && pressed.value === action;
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
				@click="press('save')"
			>
				<SpinnerIcon v-if="spinning('save')" class="w-4 h-4" />
				{{ t('dashboard.campaigns.detail.edit.actions.saveDraft') }}
			</UiButton>

			<!-- Schedule button -->
			<UiButton
				variant="secondary"
				class="gap-2"
				:disabled="isSaving || !canSchedule"
				@click="press('schedule')"
			>
				<SpinnerIcon v-if="spinning('schedule')" class="w-4 h-4" />
				<ClockIcon v-else class="w-4 h-4" />
				{{
					isScheduled
						? t('dashboard.campaigns.detail.edit.actions.reschedule')
						: t('dashboard.campaigns.detail.edit.actions.schedule')
				}}
			</UiButton>

			<!-- Send Now button -->
			<UiButton class="gap-2" :disabled="isSaving" @click="press('sendNow')">
				<SpinnerIcon v-if="spinning('sendNow')" class="w-4 h-4" />
				<PaperPlaneIcon v-else class="w-4 h-4" />
				{{ t('dashboard.campaigns.detail.edit.actions.sendNow') }}
			</UiButton>
		</div>
	</div>
</template>
