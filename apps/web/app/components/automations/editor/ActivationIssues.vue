<script setup lang="ts">
// Under a draft's canvas: what still stops it from being activated.
defineProps<{ reasons: string[] }>();

const { t } = useI18n();
</script>

<template>
	<div class="mt-6 p-4 bg-warning/10 border border-warning/20 rounded-lg">
		<div class="flex items-start gap-3">
			<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
			<div class="flex-1 min-w-0">
				<p class="font-medium text-warning mb-2">
					{{ t('dashboard.automations.detail.edit.validation.title') }}
				</p>
				<ul class="list-disc list-inside space-y-1">
					<li v-for="(reason, idx) in reasons" :key="idx" class="text-sm text-warning/80">
						{{ reason }}
					</li>
				</ul>
			</div>
		</div>
	</div>
</template>
