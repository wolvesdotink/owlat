<script setup lang="ts">
import { formatNumber } from '~/utils/formatters';

/**
 * The mail import wizard's two running steps: downloading the mail
 * (`importing`, cancellable) and teaching the assistant from it (`indexing`).
 */
defineProps<{
	step: 'importing' | 'indexing';
	migration: {
		messagesImported?: number;
		messagesIndexed?: number;
		messagesTotal?: number;
	} | null;
	importPercent: number;
	indexPercent: number;
	isDiscovering: boolean;
	isPaused: boolean;
	resumesAtLabel: string;
}>();

const emit = defineEmits<{ cancel: [] }>();

const { t, locale } = useI18n();

/** Counts read as body copy, so they follow the active locale's grouping. */
function formatCount(value: number | undefined): string {
	return formatNumber(value ?? 0, locale.value);
}
</script>

<template>
	<!-- ───────────────────────── Importing ───────────────────────── -->
	<section v-if="step === 'importing'" class="space-y-5">
		<UiCard padding="lg">
			<!-- Paused for the provider's daily download budget: the same
			     card and bar, but saying when it picks up again — the worker
			     resumes it unaided, so there is nothing to press. -->
			<div v-if="isPaused" data-testid="migrate-paused" class="flex items-center gap-3">
				<UiIconBox icon="lucide:clock" size="md" variant="brand" rounded="xl" />
				<div>
					<h2 class="font-semibold">
						{{ t('dashboard.postbox.migrate.pausedTitle', { when: resumesAtLabel }) }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.postbox.migrate.pausedBody') }}
					</p>
				</div>
			</div>
			<div v-else class="flex items-center gap-3">
				<UiIconBox icon="lucide:download-cloud" size="md" variant="brand" rounded="xl" />
				<div>
					<h2 class="font-semibold">
						{{
							isDiscovering
								? t('dashboard.postbox.migrate.discoveringTitle')
								: t('dashboard.postbox.migrate.importingTitle')
						}}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.postbox.migrate.importingBody') }}
					</p>
				</div>
			</div>

			<div class="mt-5 space-y-2">
				<UiProgressBar
					:value="importPercent"
					:indeterminate="isDiscovering"
					:aria-label="
						isDiscovering
							? t('dashboard.postbox.migrate.discoveringProgressLabel')
							: t('dashboard.postbox.migrate.importProgressLabel')
					"
				/>
				<div class="flex justify-between text-xs text-text-tertiary">
					<span v-if="isDiscovering">{{ t('dashboard.postbox.migrate.discoveringFolders') }}</span>
					<span v-else>
						{{
							t('dashboard.postbox.migrate.importCount', {
								imported: formatCount(migration?.messagesImported),
								total: formatCount(migration?.messagesTotal),
							})
						}}
					</span>
					<span v-if="!isDiscovering">{{ importPercent }}%</span>
				</div>
			</div>

			<div class="mt-5">
				<UiButton variant="danger-ghost" size="sm" @click="emit('cancel')">
					{{ t('dashboard.postbox.migrate.cancelMigration') }}
				</UiButton>
			</div>
		</UiCard>
	</section>

	<!-- ───────────────────────── Indexing (Teaching AI) ───────────────────────── -->
	<section v-else class="space-y-5">
		<UiCard padding="lg">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:sparkles" size="md" variant="success" rounded="xl" />
				<div>
					<h2 class="font-semibold">{{ t('dashboard.postbox.migrate.indexingTitle') }}</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.postbox.migrate.indexingBody') }}
					</p>
				</div>
			</div>

			<div class="mt-5 space-y-2">
				<UiProgressBar
					:value="indexPercent"
					variant="success"
					:aria-label="t('dashboard.postbox.migrate.indexProgressLabel')"
				/>
				<div class="flex justify-between text-xs text-text-tertiary">
					<span>
						{{
							t('dashboard.postbox.migrate.indexCount', {
								indexed: formatCount(migration?.messagesIndexed),
								imported: formatCount(migration?.messagesImported),
							})
						}}
					</span>
					<span>{{ indexPercent }}%</span>
				</div>
			</div>

			<p class="mt-4 text-xs text-text-tertiary">
				{{ t('dashboard.postbox.migrate.indexingFootnote') }}
			</p>
		</UiCard>
	</section>
</template>
