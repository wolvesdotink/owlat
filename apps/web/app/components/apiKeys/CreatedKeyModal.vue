<script setup lang="ts">
import { CheckIcon, CircleWarningIcon, CopyIcon, KeyIcon } from '@coolicons/vue';

defineProps<{
	open: boolean;
	/** The key just created; its secret is shown only this once. */
	createdKey: { name: string; apiKey: string; keyPrefix: string } | null;
	copied: boolean;
}>();

const emit = defineEmits<{ close: []; copy: [] }>();

const { t } = useI18n();
</script>

<template>
	<UiModal
		:open="open"
		size="lg"
		:closable="false"
		persistent
		@update:open="
			(v) => {
				if (!v) emit('close');
			}
		"
	>
		<template v-if="createdKey">
			<!-- Header -->
			<div class="flex items-center gap-3 mb-6">
				<UiIconBox :icon="KeyIcon" size="sm" variant="success" rounded="lg" />
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('dashboard.admin.team.api.index.created.title') }}
				</h2>
			</div>

			<!-- Content -->
			<div class="mb-4 p-4 rounded-lg bg-warning/10 border border-warning/20">
				<div class="flex items-start gap-3">
					<CircleWarningIcon class="w-5 h-5 text-warning shrink-0 mt-0.5" />
					<div>
						<p class="text-sm font-medium text-warning">
							{{ t('dashboard.admin.team.api.index.created.copyNow') }}
						</p>
						<p class="text-sm text-warning/80 mt-1">
							{{ t('dashboard.admin.team.api.index.created.copyNowBody') }}
						</p>
					</div>
				</div>
			</div>

			<div class="mb-4">
				<label class="label">{{ t('common.name') }}</label>
				<p class="text-text-primary font-medium">{{ createdKey.name }}</p>
			</div>

			<div>
				<label class="label">{{ t('dashboard.admin.team.api.index.created.apiKeyLabel') }}</label>
				<div class="flex items-center gap-2">
					<code
						class="flex-1 px-4 py-3 rounded-lg bg-bg-deep text-text-primary text-sm font-mono break-all border border-border-subtle"
					>
						{{ createdKey.apiKey }}
					</code>
					<UiButton variant="secondary" class="shrink-0 gap-2" @click="emit('copy')">
						<CheckIcon v-if="copied" class="w-4 h-4 text-success" />
						<CopyIcon v-else class="w-4 h-4" />
						{{ copied ? t('dashboard.admin.team.api.index.created.copied') : t('common.copy') }}
					</UiButton>
				</div>
			</div>
		</template>

		<template #footer>
			<UiButton @click="emit('close')">{{ t('common.done') }}</UiButton>
		</template>
	</UiModal>
</template>
