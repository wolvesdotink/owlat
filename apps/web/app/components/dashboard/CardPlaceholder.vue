<script setup lang="ts">
/**
 * A whole dashboard card at rest: the real `UiCard` shell, the real header
 * rhythm (icon box, title, trailing link), and a `DashboardCardSkeleton` body.
 *
 * The dashboard's own first load — while the adaptive layout query resolves —
 * used to render a single centred spinner in a `py-16` box, so the page went
 * from ~120px tall to a four-column, multi-row grid in one frame. Rendering the
 * grid up front with these placeholders keeps the geometry from the first paint.
 *
 * The body shape is chosen from the card SIZE rather than the card type on
 * purpose: the type-to-body mapping lives inside each card component and would
 * drift the moment one of them changed its layout, whereas the size is the only
 * thing the grid itself already knows and the only thing that determines how
 * much space the placeholder must hold.
 */
type CardSize = 'small' | 'medium' | 'large';

const props = withDefaults(
	defineProps<{
		size?: CardSize;
		/** Cards that link out show a trailing "view all" affordance. */
		action?: boolean;
	}>(),
	{ size: 'small', action: true }
);

const body = computed(() => {
	switch (props.size) {
		case 'large':
			return { shape: 'metrics' as const, count: 4, hero: true };
		case 'medium':
			return { shape: 'stat' as const, count: 2, hero: true };
		case 'small':
		default:
			return { shape: 'list' as const, count: 3, hero: false };
	}
});
</script>

<template>
	<UiCard class="h-full" padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiSkeleton class="size-8 rounded-xl" />
					<UiSkeleton class="h-3.5 w-32" />
				</div>
				<UiSkeleton v-if="action" class="h-3 w-16" />
			</div>
			<DashboardCardSkeleton
				:shape="body.shape"
				:count="body.count"
				:hero="body.hero"
				:avatar="size === 'small'"
			/>
		</div>
	</UiCard>
</template>
