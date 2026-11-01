<script setup lang="ts">
// The campaign editor's action row: Cancel, Save draft, Schedule / Reschedule
// and Send now. On a phone the three send actions take their own line
// (wrapping, right-aligned) instead of squeezing every label onto two lines and
// pushing Send now past the edge.
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
				<Icon
					v-if="isSaving"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				{{ t('dashboard.campaigns.detail.edit.actions.saveDraft') }}
			</UiButton>

			<!-- Schedule button -->
			<UiButton
				variant="secondary"
				class="gap-2"
				:disabled="isSaving || !canSchedule"
				@click="emit('schedule')"
			>
				<Icon
					v-if="isSaving"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:clock" class="w-4 h-4" />
				{{
					isScheduled
						? t('dashboard.campaigns.detail.edit.actions.reschedule')
						: t('dashboard.campaigns.detail.edit.actions.schedule')
				}}
			</UiButton>

			<!-- Send Now button -->
			<UiButton class="gap-2" :disabled="isSaving" @click="emit('sendNow')">
				<Icon
					v-if="isSaving"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:send" class="w-4 h-4" />
				{{ t('dashboard.campaigns.detail.edit.actions.sendNow') }}
			</UiButton>
		</div>
	</div>
</template>
