<script setup lang="ts">
// The builder's canvas before the first step: Add email or Add delay.
import type { StepKind } from '~/composables/automations/steps';

const emit = defineEmits<{ add: [stepType: StepKind] }>();

const { t } = useI18n();
</script>

<template>
	<div class="card p-8 text-center">
		<div class="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-surface flex items-center justify-center">
			<Icon name="lucide:zap" class="w-8 h-8 text-text-tertiary" />
		</div>
		<h3 class="text-lg font-semibold text-text-primary mb-2">
			{{ t('dashboard.automations.detail.edit.empty.title') }}
		</h3>
		<p class="text-text-secondary mb-4">
			{{ t('dashboard.automations.detail.edit.empty.body') }}
		</p>
		<div class="flex justify-center gap-3">
			<UiButton class="gap-2" @click="emit('add', 'email')">
				<Icon name="lucide:mail" class="w-4 h-4" />
				{{ t('dashboard.automations.detail.edit.empty.addEmail') }}
			</UiButton>
			<UiButton variant="secondary" class="gap-2" @click="emit('add', 'delay')">
				<Icon name="lucide:clock" class="w-4 h-4" />
				{{ t('dashboard.automations.detail.edit.empty.addDelay') }}
			</UiButton>
		</div>
	</div>
</template>
