<script setup lang="ts">
/**
 * "Run on existing mail" for one filter.
 *
 * A new filter has never seen the backlog that motivated writing it. This
 * starts the batched, resumable sweep (`mail/filterRun`) and shows its
 * progress; the sweep applies only the reversible actions (label, move, mark
 * read, mark flagged) — a rule whose only actions are forward/delete/discard
 * has nothing safe to apply retroactively and says so instead of offering a
 * button that would do nothing.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	filterId: Id<'mailFilters'>;
	/** False when the rule only forwards/deletes/discards. */
	canRun: boolean;
}>();

const { t } = useI18n();

const { data } = useConvexQuery(api.mail.filterRun.status, () => ({ filterId: props.filterId }));
const job = computed(() => data.value ?? null);

const startOp = useBackendOperation(api.mail.filterRun.start, {
	label: () => t('shared.postbox.usePostboxFilters.runOnExistingMail'),
});
const cancelOp = useBackendOperation(api.mail.filterRun.cancel, {
	label: () => t('shared.postbox.usePostboxFilters.cancelFilterRun'),
});

const isRunning = computed(() => job.value?.status === 'running');
</script>

<template>
	<div class="flex items-center gap-2 text-xs">
		<span v-if="!canRun" class="text-text-tertiary">
			{{ t('components.postbox.postboxFilterRunControl.nothingToApply') }}
		</span>
		<template v-else-if="isRunning">
			<Icon name="lucide:loader-2" class="w-3.5 h-3.5 animate-spin text-text-tertiary" />
			<span class="text-text-tertiary">
				{{
					t('components.postbox.postboxFilterRunControl.running', {
						scanned: job?.scannedCount ?? 0,
						matched: job?.matchedCount ?? 0,
					})
				}}
			</span>
			<button
				type="button"
				class="text-brand hover:underline"
				@click="cancelOp.run({ filterId: props.filterId })"
			>
				{{ t('common.cancel') }}
			</button>
		</template>
		<template v-else>
			<span v-if="job?.status === 'completed'" class="text-text-tertiary">
				{{
					t('components.postbox.postboxFilterRunControl.completed', {
						matched: job.matchedCount,
					})
				}}
			</span>
			<span v-else-if="job?.status === 'cancelled'" class="text-text-tertiary">
				{{
					t('components.postbox.postboxFilterRunControl.cancelled', {
						matched: job.matchedCount,
					})
				}}
			</span>
			<button
				type="button"
				class="text-brand hover:underline"
				:disabled="startOp.isLoading.value"
				@click="startOp.run({ filterId: props.filterId })"
			>
				{{
					job
						? t('components.postbox.postboxFilterRunControl.runAgain')
						: t('components.postbox.postboxFilterRunControl.run')
				}}
			</button>
		</template>
	</div>
</template>
