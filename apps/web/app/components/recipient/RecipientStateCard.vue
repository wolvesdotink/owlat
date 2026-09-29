<script setup lang="ts">
/**
 * One state of a recipient page: the spinner while the link is checked, the
 * error, the success, the "already done" and the question before the action.
 * Every recipient page draws these the same way, so the icons, the heading
 * level and the 320px sizing live here once. Extra copy (the organization in
 * bold, the sender's address, the action button) goes in the default slot.
 *
 * `bare` drops the card chrome for the full-screen email pages (share,
 * archive), which centre the state on the page instead of in a card.
 */
import { computed } from 'vue';

type Variant = 'loading' | 'error' | 'success' | 'already' | 'prompt' | 'expired';
type Glyph = 'warning' | 'check' | 'mail' | 'clock';
type Tone = 'error' | 'success' | 'brand' | 'neutral' | 'muted';

const props = withDefaults(
	defineProps<{
		variant: Variant;
		heading?: string;
		/** Plain copy under the heading; the loading label for `loading`. */
		message?: string;
		/** Overrides the variant's colour, e.g. a neutral `prompt`. */
		tone?: Tone;
		width?: 'md' | 'lg';
		bare?: boolean;
	}>(),
	{ heading: undefined, message: undefined, tone: undefined, width: 'md', bare: false }
);

const GLYPHS: Record<Glyph, string> = {
	warning:
		'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
	check: 'M5 13l4 4L19 7',
	mail: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
	clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
};

const TONES: Record<Tone, { circle: string; icon: string }> = {
	error: { circle: 'bg-error-subtle', icon: 'text-error' },
	success: { circle: 'bg-success-subtle', icon: 'text-success' },
	brand: { circle: 'bg-brand-subtle', icon: 'text-brand' },
	neutral: { circle: 'bg-bg-surface', icon: 'text-text-secondary' },
	muted: { circle: 'bg-bg-surface', icon: 'text-text-tertiary' },
};

const LOOKS: Record<Exclude<Variant, 'loading'>, { glyph: Glyph; tone: Tone }> = {
	error: { glyph: 'warning', tone: 'error' },
	success: { glyph: 'check', tone: 'success' },
	already: { glyph: 'check', tone: 'brand' },
	prompt: { glyph: 'mail', tone: 'brand' },
	expired: { glyph: 'clock', tone: 'muted' },
};

const look = computed(() => {
	if (props.variant === 'loading') return null;
	const base = LOOKS[props.variant];
	return { path: GLYPHS[base.glyph], ...TONES[props.tone ?? base.tone] };
});

const rootClass = computed(() => [
	'w-full',
	props.width === 'lg' ? 'max-w-lg' : 'max-w-md',
	props.bare ? 'text-center' : 'card',
	!props.bare && props.variant === 'loading' ? 'py-8 text-center' : '',
]);
</script>

<template>
	<div :class="rootClass" :role="variant === 'loading' ? 'status' : undefined">
		<div v-if="variant === 'loading'" class="flex flex-col items-center gap-4">
			<UiSpinner size="lg" />
			<p class="text-text-secondary" :class="{ 'text-sm': bare }">{{ message }}</p>
		</div>
		<div v-else-if="look" :class="{ 'py-2 text-center sm:py-4': !bare }">
			<div
				class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full sm:h-16 sm:w-16"
				:class="look.circle"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-7 w-7 sm:h-8 sm:w-8"
					:class="look.icon"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					aria-hidden="true"
				>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="look.path" />
				</svg>
			</div>
			<h2 v-if="heading" class="mb-2 text-lg font-semibold text-text-primary">{{ heading }}</h2>
			<p v-if="message" class="text-text-secondary">{{ message }}</p>
			<slot />
		</div>
	</div>
</template>
