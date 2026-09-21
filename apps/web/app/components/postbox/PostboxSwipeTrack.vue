<script setup lang="ts">
/**
 * The coloured track revealed behind a thread row while it is being swiped
 * (UX plan idea 21).
 *
 * It answers the only question a swipe raises mid-gesture — "what happens if I
 * let go now?" — with the verb's own icon and name, in the verb's own colour,
 * growing as the drag approaches the commit distance and snapping to full
 * strength the moment releasing would actually fire it. Without that, a swipe is
 * a leap of faith on a mailbox.
 *
 * The icon sits on the side the row UNCOVERS: dragging left moves the row left,
 * so the track shows on the right. Purely decorative (`aria-hidden`) — the
 * gesture's outcome is announced by the undo toast the triage verb raises, which
 * is also where it can be reversed.
 *
 * Its own component so PostboxThreadRow stays inside the file-size ratchet.
 */
import type { PostboxSwipeTone, PostboxSwipeTrackState } from '~/utils/postboxSwipe';

const props = defineProps<{ track: PostboxSwipeTrackState }>();

const { t } = useI18n();

/**
 * Tone → concrete classes. Spelled out rather than interpolated because
 * Tailwind scans source text: `bg-${tone}/10` would generate nothing.
 */
const TONE_CLASSES: Record<PostboxSwipeTone, { fill: string; ink: string; armed: string }> = {
	brand: { fill: 'bg-brand/10', ink: 'text-brand', armed: 'bg-brand/25' },
	error: { fill: 'bg-error/10', ink: 'text-error', armed: 'bg-error/25' },
	warning: { fill: 'bg-warning/10', ink: 'text-warning', armed: 'bg-warning/25' },
	info: { fill: 'bg-info/10', ink: 'text-info', armed: 'bg-info/25' },
};

const tone = computed(() => TONE_CLASSES[props.track.tone]);

/** The verb's name, from the same catalog the settings picker renders. */
const label = computed(() => t(`shared.postboxSwipe.actions.${props.track.action}`));

/**
 * The icon fades and grows in over the first half of the travel, so a drag that
 * has barely started does not already look like a decision.
 */
const iconStyle = computed(() => {
	const eased = Math.min(1, props.track.progress * 2);
	return { opacity: `${0.35 + eased * 0.65}`, transform: `scale(${0.85 + eased * 0.15})` };
});
</script>

<template>
	<div
		class="pbx-swipe-track absolute inset-0 flex items-center px-5 pointer-events-none"
		:class="[
			track.armed ? tone.armed : tone.fill,
			track.direction === 'left' ? 'justify-end' : 'justify-start',
		]"
		aria-hidden="true"
	>
		<span class="pbx-swipe-track-mark flex items-center gap-2" :class="tone.ink" :style="iconStyle">
			<Icon :name="track.icon" class="w-5 h-5" />
			<span class="text-xs font-medium">{{ label }}</span>
		</span>
	</div>
</template>
