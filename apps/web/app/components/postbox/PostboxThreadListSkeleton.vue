<script setup lang="ts">
/**
 * Layout-matching placeholder for PostboxThreadList / PostboxThreadGroupList.
 *
 * Each shimmer row copies the real row geometry (px-4 py-3, 76px total - the
 * same value as the list's contain-intrinsic-size) with checkbox/sender/date,
 * subject and snippet bars, so the pane doesn't reflow when data lands.
 * Shown only on first load (no data yet); live-query refreshes keep rows.
 *
 * Held back for 150 ms (`useDelayedLoading`, plan 2.8) while keeping its box,
 * so a folder the cache or a fast answer fills in time never flashes it.
 */
import { useDelayedLoading } from '@owlat/ui/composables/useDelayedLoading';

withDefaults(defineProps<{ rows?: number }>(), { rows: 8 });

// It unmounts the moment the rows land, so only the delay half applies.
const visible = useDelayedLoading(true, { minVisible: 0 });
</script>

<template>
	<ul
		aria-hidden="true"
		data-testid="postbox-thread-list-skeleton"
		class="divide-y divide-border-subtle"
		:class="{ invisible: !visible }"
	>
		<li v-for="i in rows" :key="i" class="px-4 py-3" style="height: 76px">
			<div class="flex items-start gap-2">
				<UiSkeleton circle class="mt-0.5 w-4 h-4 flex-shrink-0" />
				<div class="flex-1 min-w-0">
					<div class="flex items-baseline justify-between gap-3">
						<UiSkeleton class="h-3.5 w-32" />
						<UiSkeleton class="h-3 w-8 flex-shrink-0" />
					</div>
					<UiSkeleton class="h-3.5 w-3/4 mt-1.5" />
					<UiSkeleton class="h-3 w-1/2 mt-1.5" />
				</div>
			</div>
		</li>
	</ul>
</template>
