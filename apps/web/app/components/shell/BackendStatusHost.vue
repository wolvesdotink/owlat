<script setup lang="ts">
/**
 * Mounted once, beside the global toast host: runs the backend status notices
 * (`useBackendStatusNotices`) and owns the slow-save Details dialog.
 */
import { useBackendStatusNotices } from '~/composables/useBackendStatusNotices';
import ShellConnectionIndicator from './ConnectionIndicator.vue';

const { t } = useI18n();
const { formatTime } = useFormat();
const { detailsOpen, groups, phase, hint } = useBackendStatusNotices();
</script>

<template>
	<UiModal v-model:open="detailsOpen" :title="t('shared.backendStatus.detailsTitle')" size="md">
		<div class="space-y-4 text-sm" data-testid="slow-save-details">
			<p v-if="phase" class="flex items-start gap-2 text-text-secondary">
				<ShellConnectionIndicator compact class="mt-1" />
				<span>{{ hint }}</span>
			</p>
			<template v-if="groups.length > 0">
				<p class="text-text-secondary">{{ t('shared.backendStatus.detailsIntro') }}</p>
				<ul class="divide-y divide-border-subtle rounded-lg border border-border-subtle">
					<li
						v-for="group in groups"
						:key="group.label"
						class="flex items-baseline justify-between gap-4 px-3 py-2"
					>
						<span class="min-w-0 truncate text-text-primary">
							{{ group.label }}
							<span v-if="group.count > 1" class="text-text-tertiary">
								· {{ t('shared.backendStatus.changeCount', { count: group.count }, group.count) }}
							</span>
						</span>
						<span class="shrink-0 text-xs text-text-tertiary tabular-nums">
							{{ t('shared.backendStatus.waitingSince', { time: formatTime(group.since) }) }}
						</span>
					</li>
				</ul>
			</template>
			<p v-else class="text-text-secondary">{{ t('shared.backendStatus.nothingWaiting') }}</p>
		</div>
	</UiModal>
</template>
