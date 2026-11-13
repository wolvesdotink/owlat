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
import {
	CheckIcon,
	ClockIcon,
	MailIcon,
	TriangleWarningIcon,
	type IconComponent,
} from '@coolicons/vue';

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

// The app's own icon set, so these states match every other surface.
const GLYPHS: Record<Glyph, IconComponent> = {
	warning: TriangleWarningIcon,
	check: CheckIcon,
	mail: MailIcon,
	clock: ClockIcon,
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
	return { glyph: GLYPHS[base.glyph], ...TONES[props.tone ?? base.tone] };
});

// A failed or expired link is news the reader has to hear; the other states
// are what they asked for.
const role = computed(() => {
	if (props.variant === 'loading') return 'status';
	if (props.variant === 'error' || props.variant === 'expired') return 'alert';
	return undefined;
});

const rootClass = computed(() => [
	'w-full',
	props.width === 'lg' ? 'max-w-lg' : 'max-w-md',
	props.bare ? 'text-center' : 'card',
	!props.bare && props.variant === 'loading' ? 'py-8 text-center' : '',
]);
</script>

<template>
	<div :class="rootClass" :role="role">
		<div v-if="variant === 'loading'" class="flex flex-col items-center gap-4">
			<UiSpinner size="lg" />
			<p class="text-text-secondary" :class="{ 'text-sm': bare }">{{ message }}</p>
		</div>
		<div v-else-if="look" :class="{ 'py-2 text-center sm:py-4': !bare }">
			<div
				class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full sm:h-16 sm:w-16"
				:class="look.circle"
			>
				<component
					:is="look.glyph"
					class="h-7 w-7 sm:h-8 sm:w-8"
					:class="look.icon"
					aria-hidden="true"
				/>
			</div>
			<h2 v-if="heading" class="mb-2 text-lg font-semibold text-text-primary">{{ heading }}</h2>
			<p v-if="message" class="text-text-secondary">{{ message }}</p>
			<slot />
		</div>
	</div>
</template>
