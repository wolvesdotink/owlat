<script setup lang="ts">
/**
 * The one page header: the landing page's ladder, as a primitive.
 *
 * Every product surface used to hand-roll the same block — a flex row, an
 * `h1.text-2xl.font-medium.tracking-[-0.02em]`, a `mt-1` secondary paragraph,
 * and whatever buttons the page had. Copied across ~77 pages it drifted: some
 * titles ended up `font-semibold`, leads ran the full width of the content
 * column, and the ladder the marketing site is built on (eyebrow → title → one
 * capped lead) existed nowhere in the app. Fixing that per page means fixing it
 * 77 times; fixing it here makes every later page a one-component swap.
 *
 * The recipe is the landing one, not a new one:
 *  - `lp-eyebrow` — the shared uppercase tertiary micro-label;
 *  - the title at weight 450 with −0.02em tracking, the app-scale sibling of
 *    `lp-title` (the display clamp is for hero surfaces, not a dashboard);
 *  - one `--color-text-secondary` lead capped at 540px, the measure the
 *    marketing sections use, so a long subtitle wraps like prose instead of
 *    stretching into a single thin line.
 *
 * `#meta` carries the counts/dates strip detail pages hang under the lead;
 * `#actions` carries the page's buttons and stays top-aligned with the title
 * so the row does not jump when the lead wraps to two lines. Outer spacing is
 * deliberately NOT owned here — call sites keep their own `mb-*`, because the
 * gap to the content below belongs to the page's rhythm, not to the header.
 */
interface Props {
	/** Uppercase micro-label above the title (the section this page sits in). */
	eyebrow?: string;
	/** The page title. Rendered as the page's `h1`. */
	title: string;
	/** One-sentence lead under the title, capped at the 540px measure. */
	description?: string;
}

defineProps<Props>();

const slots = useSlots();
</script>

<template>
	<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<div class="min-w-0">
			<span v-if="eyebrow" class="lp-eyebrow mb-1.5">{{ eyebrow }}</span>
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">{{ title }}</h1>
			<p v-if="description" class="mt-1 max-w-[540px] text-text-secondary">
				{{ description }}
			</p>
			<div v-if="slots['meta']" class="mt-3">
				<slot name="meta" />
			</div>
		</div>
		<!-- Wraps by default: at 375px three header actions are wider than the
		     viewport, and `shrink-0` on a nowrap row pushed the primary off the
		     right edge. `shrink-0` only earns its keep from `sm:` up, where the
		     row sits beside the title and must not squeeze it. -->
		<div v-if="slots['actions']" class="flex flex-wrap items-center gap-2 sm:shrink-0">
			<slot name="actions" />
		</div>
	</div>
</template>
