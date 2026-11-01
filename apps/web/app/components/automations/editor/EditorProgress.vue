<script setup lang="ts">
// The builder's two-step progress line: the trigger is chosen, the workflow is
// being built.
import { CheckIcon } from '@coolicons/vue';

const { t } = useI18n();
</script>

<template>
	<div class="bg-bg-elevated border-b border-border-subtle shrink-0">
		<div class="max-w-7xl mx-auto px-4 py-4 sm:px-6">
			<div class="flex items-center gap-3">
				<div class="flex items-center gap-2">
					<div
						class="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand border-2 border-brand text-sm font-medium"
					>
						<CheckIcon class="w-4 h-4" />
					</div>
					<span class="text-sm font-medium text-text-primary">{{
						t('dashboard.automations.detail.edit.steps.chooseTrigger')
					}}</span>
				</div>
				<div class="flex-1 h-0.5 bg-brand" />
				<div class="flex items-center gap-2">
					<div
						class="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand border-2 border-brand text-sm font-medium"
					>
						2
					</div>
					<span class="text-sm font-medium text-text-primary">{{
						t('dashboard.automations.detail.edit.steps.buildWorkflow')
					}}</span>
				</div>
			</div>
		</div>
	</div>
</template>
