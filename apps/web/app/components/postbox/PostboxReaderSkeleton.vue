<script setup lang="ts">
/**
 * Layout-matching placeholder for a message card in the thread reader:
 * avatar + header bars + paragraph bars, mirroring the expanded-message
 * layout in PostboxThreadReader. `with-header=false` renders only the
 * paragraph block (used while a blob-stored body downloads in
 * PostboxMessageBody).
 */
withDefaults(defineProps<{ withHeader?: boolean }>(), { withHeader: true });
</script>

<template>
	<div
		aria-hidden="true"
		data-testid="postbox-reader-skeleton"
		:class="withHeader ? 'border border-border-subtle rounded bg-bg-surface px-4 py-3' : ''"
	>
		<div v-if="withHeader" class="flex items-start gap-3">
			<UiSkeleton circle class="w-9 h-9 flex-shrink-0" />
			<div class="flex-1 min-w-0">
				<div class="flex items-baseline justify-between gap-3">
					<UiSkeleton class="h-4 w-40" />
					<UiSkeleton class="h-3 w-24" />
				</div>
				<UiSkeleton class="h-3 w-56 mt-2" />
			</div>
		</div>
		<div class="space-y-2" :class="withHeader ? 'mt-4' : ''">
			<UiSkeleton class="h-3.5 w-full" />
			<UiSkeleton class="h-3.5 w-11/12" />
			<UiSkeleton class="h-3.5 w-full" />
			<UiSkeleton class="h-3.5 w-2/3" />
		</div>
	</div>
</template>
