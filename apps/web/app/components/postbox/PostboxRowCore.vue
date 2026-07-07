<script setup lang="ts">
/**
 * Shared thread-list row core — the text column that the Postbox message list
 * (PostboxThreadRow) and the Team Inbox thread list (InboxThreadRow) both build
 * on, so the two surfaces render the SAME row DNA instead of each hand-rolling
 * the skeleton.
 *
 * It owns exactly the parts that are genuinely identical across surfaces: the
 * `flex-1 min-w-0` column, the baseline header row (identifier on the left,
 * timestamp on the right), and the weight-based unread emphasis — an unread row's
 * identifier is font-weight 550/semibold, NEVER a colour, per the design system.
 * Timestamps are tabular-nums so relative times don't jitter.
 *
 * Everything below the header (subject + inline indicators, the snippet line) is
 * surface-specific — Postbox carries density-coupled classes there — so it comes
 * through the default slot rather than being imposed here. Pure presentational:
 * no data fetching, no mutations.
 *
 * Slots:
 *   identifier — sender/contact name (left of the header baseline row)
 *   meta       — trailing timestamp (right of the header baseline row)
 *   default    — the detail row + snippet line the surface supplies
 */
defineProps<{
	/** Weight-based emphasis: unread identifiers render at 550/semibold. */
	unread?: boolean;
}>();
</script>

<template>
	<div class="flex-1 min-w-0">
		<div class="flex items-baseline justify-between gap-3">
			<span
				class="truncate text-sm"
				:class="unread ? 'font-semibold text-text-primary' : 'text-text-secondary'"
			>
				<slot name="identifier" />
			</span>
			<span class="text-xs text-text-tertiary flex-shrink-0 tabular-nums">
				<slot name="meta" />
			</span>
		</div>
		<slot />
	</div>
</template>
