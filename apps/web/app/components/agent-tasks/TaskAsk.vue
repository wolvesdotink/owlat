<script setup lang="ts">
/**
 * The ask of an agent task card: ONE 550-weight sentence saying what the agent
 * needs ("Should we approve the refund?"), an optional muted one-line WHY
 * (sourced from the existing attribution / decision-rationale data — every
 * agent ask explains why), and an optional muted detail excerpt.
 *
 * Weight-based emphasis per the design brief: the ask stands out through
 * font-weight 550 (`font-semibold` maps to --font-weight-semibold: 550),
 * never through color.
 */
withDefaults(
	defineProps<{
		/** The one-sentence ask. Omit when only a detail excerpt is shown. */
		ask?: string;
		/** Muted one-line WHY the agent is asking (attribution / rationale). */
		why?: string;
		/** Muted supporting excerpt (message snippet, draft preview). */
		detail?: string;
		/** Clamp the detail excerpt to a few lines. */
		clampDetail?: boolean;
	}>(),
	{ ask: undefined, why: undefined, detail: undefined, clampDetail: true }
);
</script>

<template>
	<div data-testid="task-ask">
		<p v-if="ask" class="text-sm font-semibold text-text-primary">{{ ask }}</p>
		<p
			v-if="detail"
			class="text-sm text-text-secondary whitespace-pre-line"
			:class="[ask ? 'mt-0.5' : '', clampDetail ? 'line-clamp-3' : '']"
		>
			{{ detail }}
		</p>
		<p v-if="why" data-testid="task-ask-why" class="mt-1 text-[11px] text-text-tertiary">
			{{ why }}
		</p>
	</div>
</template>
