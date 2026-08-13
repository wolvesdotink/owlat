<script setup lang="ts">
/**
 * "You can send to about N contacts today" — the ramp cap, shown WHERE THE
 * OPERATOR ACTS rather than discovered as a pre-flight refusal.
 *
 * The number comes from the same paced warming projection the binding gate and
 * the multi-day walker meter against (`campaigns/sendingReadiness.ts`), so this
 * line and the capacity schedule panel beside it can never disagree. The copy
 * itself is derived once in `~/lib/sendReadiness` because three surfaces render
 * it (the campaign editor, the wizard's review step, the getting-started card).
 *
 * Informational treatment, never the error one: a capped day is a normal state
 * for a warming deployment (deliverability plan D14). Nothing renders at all
 * when capacity could not be measured — a readiness line nobody can stand behind
 * is worse than no line.
 */
import { sendReadinessNote, type SendingReadiness } from '~/lib/sendReadiness';

const props = defineProps<{
	readiness: SendingReadiness | null | undefined;
	/** Eligible recipients, when this surface knows them. */
	audienceSize?: number | null;
	/** Clock override for tests; defaults to the render-time wall clock. */
	now?: number;
}>();

const note = computed(() =>
	sendReadinessNote(props.readiness, {
		audienceSize: props.audienceSize ?? null,
		now: props.now ?? Date.now(),
	})
);

const TONE = {
	ready: {
		box: 'bg-success/10 border-success/20',
		icon: 'text-success',
		name: 'lucide:check-circle',
	},
	paced: {
		box: 'bg-accent/5 border-accent/20',
		icon: 'text-accent',
		name: 'lucide:calendar-clock',
	},
	waiting: {
		box: 'bg-warning/10 border-warning/20',
		icon: 'text-warning',
		name: 'lucide:clock',
	},
} as const;

const tone = computed(() => TONE[note.value?.tone ?? 'ready']);
</script>

<template>
	<div
		v-if="note"
		class="flex items-start gap-3 p-3 border rounded-lg"
		:class="tone.box"
		data-testid="send-readiness-note"
	>
		<Icon :name="tone.name" class="w-5 h-5 shrink-0 mt-0.5" :class="tone.icon" />
		<div class="min-w-0">
			<p class="text-sm font-medium text-text-primary">{{ note.headline }}</p>
			<p v-if="note.detail" class="text-sm text-text-secondary mt-0.5">{{ note.detail }}</p>
		</div>
	</div>
</template>
