<script setup lang="ts">
/**
 * The knowledge list while its first page loads: a column of placeholders at
 * `KnowledgeEntryCard`'s geometry (bordered p-4 card, 40px type tile, a title
 * line over two lines of excerpt) instead of a centred spinner, so the column
 * keeps its height when the entries land. Held back 150 ms like every other
 * loader (`useDelayedLoading`), keeping its box meanwhile.
 */
import { useDelayedLoading } from '@owlat/ui/composables/useDelayedLoading';

withDefaults(defineProps<{ rows?: number }>(), { rows: 4 });

const { t } = useI18n();
const visible = useDelayedLoading(true, { minVisible: 0 });

/** Ragged title widths, stable across re-renders. */
const TITLE_WIDTHS = ['w-1/2', 'w-2/3', 'w-2/5', 'w-3/5'];
</script>

<template>
	<div data-testid="knowledge-entry-list-skeleton" aria-busy="true">
		<p role="status" class="sr-only">{{ t('common.loading') }}</p>
		<div aria-hidden="true" class="space-y-3" :class="{ invisible: !visible }">
			<div
				v-for="row in rows"
				:key="row"
				class="flex items-start gap-4 p-4 rounded-xl border border-border-subtle bg-bg-elevated"
			>
				<UiSkeleton class="size-10 shrink-0 rounded-lg" />
				<div class="flex-1 min-w-0">
					<UiSkeleton class="h-4 mb-2" :class="TITLE_WIDTHS[(row - 1) % TITLE_WIDTHS.length]" />
					<UiSkeletonText :lines="2" size="sm" />
				</div>
			</div>
		</div>
	</div>
</template>
