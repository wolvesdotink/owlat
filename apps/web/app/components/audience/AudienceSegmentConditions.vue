<script setup lang="ts">
/**
 * The segment builder's condition list: each condition in its per-kind editor
 * (numbered, with a remove button), an empty state, and "Add condition". The
 * conditions belong to the page's segment form; this list only asks for
 * changes, so the form stays the one owner of the filters it saves.
 */
import type { Condition } from '~/composables/conditions';
import { CloseIcon, FilterIcon, PlusIcon } from '@coolicons/vue';

defineProps<{
	conditions: Condition[];
	/** The form's validation message for the conditions, if any. */
	error?: string;
}>();

const emit = defineEmits<{
	add: [];
	remove: [index: number];
	update: [index: number, next: Condition];
}>();

const { t } = useI18n();
</script>

<template>
	<div class="mb-6">
		<div class="flex items-center justify-between mb-3">
			<label class="label mb-0">{{
				t('dashboard.audience.segments.index.modal.conditions')
			}}</label>
			<UiButton variant="secondary" size="sm" type="button" class="gap-1" @click="emit('add')">
				<PlusIcon class="w-3 h-3" />
				{{ t('dashboard.audience.segments.index.modal.addCondition') }}
			</UiButton>
		</div>

		<!-- Conditions Error -->
		<div v-if="error" class="mb-3 p-3 rounded-lg bg-error-subtle border border-error/20">
			<p class="text-sm text-error">{{ error }}</p>
		</div>

		<!-- Empty state -->
		<div
			v-if="conditions.length === 0"
			class="p-8 border-2 border-dashed border-border-subtle rounded-xl text-center"
		>
			<FilterIcon class="w-8 h-8 text-text-tertiary mx-auto mb-2" :stroke-width="1.5" />
			<p class="text-text-secondary text-sm">
				{{ t('dashboard.audience.segments.index.modal.noConditions') }}
			</p>
			<p class="text-text-tertiary text-xs mt-1">
				{{ t('dashboard.audience.segments.index.modal.noConditionsHint') }}
			</p>
		</div>

		<!-- Condition rows -->
		<div class="space-y-3">
			<div
				v-for="(condition, index) in conditions"
				:key="index"
				class="p-4 bg-bg-surface rounded-xl border border-border-subtle"
			>
				<div class="flex items-start gap-3">
					<!-- Condition number -->
					<div
						class="shrink-0 w-6 h-6 rounded-full bg-bg-elevated text-text-tertiary text-xs flex items-center justify-center"
					>
						{{ index + 1 }}
					</div>

					<!-- Condition fields (per-kind editor via the Condition editor module) -->
					<div class="flex-1 space-y-3">
						<ConditionsConditionEditor
							:model-value="condition"
							variant="row"
							@update:model-value="emit('update', index, $event)"
						/>
					</div>

					<!-- Remove button -->
					<UiTooltip :text="t('dashboard.audience.segments.index.modal.removeCondition')">
						<button
							type="button"
							class="shrink-0 p-1.5 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							:aria-label="t('dashboard.audience.segments.index.modal.removeCondition')"
							@click="emit('remove', index)"
						>
							<CloseIcon class="w-4 h-4" />
						</button>
					</UiTooltip>
				</div>
			</div>
		</div>
	</div>
</template>
