<script setup lang="ts">
/**
 * "Sending over 4 days · day 1 of 4 · 5 000 of 20 000" (deliverability plan
 * D14, P3-7).
 *
 * A warming deployment with no relay to overflow to sends a large campaign over
 * several days. That is a NORMAL, VISIBLE state — not an error and not a
 * surprise — so this is a neutral informational line, present from the moment
 * the send starts, in the same register as the rest of the campaign header. It
 * carries no warning colour, no icon of alarm and nothing to dismiss or fix.
 *
 * It renders NOTHING for an ordinary same-day send, and nothing at all when
 * there is no walk in flight: absence of a plan is not a state to explain.
 */

interface SendPlanProgress {
	isMultiDay: boolean;
	day: number;
	totalDays: number;
	enqueued: number;
	total: number;
	isTruncated: boolean;
}

const props = defineProps<{ progress: SendPlanProgress | null | undefined }>();

const formatCount = (value: number) => new Intl.NumberFormat().format(value);

/**
 * "over N days", or "over more than N days" when the plan is longer than we are
 * willing to enumerate. A truncated plan is never quoted as a finish date.
 */
const headline = computed(() => {
	const progress = props.progress;
	if (!progress) return null;
	return progress.isTruncated
		? `Sending over more than ${progress.totalDays} days`
		: `Sending over ${progress.totalDays} days`;
});

const detail = computed(() => {
	const progress = props.progress;
	if (!progress) return null;
	const parts = [`day ${progress.day} of ${progress.totalDays}`];
	// The denominator is only quoted when there is one: a walk whose audience
	// count could not be taken says how far it has come, not how far it has left.
	if (progress.total > 0) {
		parts.push(`${formatCount(progress.enqueued)} of ${formatCount(progress.total)}`);
	} else if (progress.enqueued > 0) {
		parts.push(`${formatCount(progress.enqueued)} sent`);
	}
	return parts.join(' · ');
});
</script>

<template>
	<p v-if="progress?.isMultiDay && headline" class="send-plan-line">
		<span class="send-plan-line__headline">{{ headline }}</span>
		<span class="send-plan-line__detail">{{ detail }}</span>
	</p>
</template>

<style scoped>
.send-plan-line {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	align-items: baseline;
	font-size: 0.875rem;
	color: var(--color-text-muted, #6b7280);
}

.send-plan-line__headline {
	font-weight: 600;
	color: var(--color-text, inherit);
}
</style>
