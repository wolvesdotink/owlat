<script setup lang="ts">
/**
 * Honest sender-authentication badge for the reader (Sealed Mail A3, flag
 * `senderAuthBadges`). Modeled on PostboxSecurityBadge: quiet when the sender
 * is verified, expandable for the plain-language detail; louder (warn/danger)
 * when the sender can't be verified or is impersonating a domain.
 *
 * Every string it can render is derived by `deriveSenderAuth` and maps 1:1 to a
 * checked condition — the derivation unit test is the honesty audit. When the
 * flag is off, or there are no verdicts to reason about (a legacy row), it
 * renders nothing.
 */
import { deriveSenderAuth, type SenderAuthInput, type SenderAuthResult } from '~/utils/senderAuth';

const props = defineProps<{
	/** Feature-flag gate: when false the badge renders nothing. */
	enabled: boolean;
	auth: SenderAuthInput;
}>();

const result = computed(() => (props.enabled ? deriveSenderAuth(props.auth) : null));

// Quiet by default when verified; the warn/danger states start expanded so the
// reader sees why without having to reach for it. Watch the derived STATE (a
// primitive) rather than the result object: the parent passes a fresh `auth`
// object on every render, so keying off object identity would re-snap the
// reader's manual expand/collapse on any unrelated re-render.
const expanded = ref(false);
watch(
	() => result.value?.state,
	(state) => {
		expanded.value = state ? state !== 'verified' : false;
	},
	{ immediate: true }
);

// One table keyed by the tone discriminator so chip and icon styling never
// drift apart. FF tokens only.
const TONE_CLASSES: Record<SenderAuthResult['tone'], { chip: string; icon: string }> = {
	ok: { chip: 'border-border-subtle text-text-secondary', icon: 'text-success' },
	warn: { chip: 'border-warning/40 text-warning', icon: 'text-warning' },
	danger: { chip: 'border-error/40 text-error', icon: 'text-error' },
};
const FALLBACK_TONE = {
	chip: 'border-border-subtle text-text-secondary',
	icon: 'text-text-tertiary',
};

const toneClasses = computed(() => {
	const tone = result.value?.tone;
	return tone ? TONE_CLASSES[tone] : FALLBACK_TONE;
});
</script>

<template>
	<div v-if="result" class="mt-2" data-testid="auth-badge">
		<button
			type="button"
			class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
			:class="toneClasses.chip"
			:aria-expanded="expanded"
			data-testid="auth-badge-toggle"
			@click="expanded = !expanded"
		>
			<Icon :name="result.icon" class="w-3.5 h-3.5" :class="toneClasses.icon" />
			<span data-testid="auth-badge-summary">{{ result.summary }}</span>
			<Icon
				:name="expanded ? 'lucide:chevron-up' : 'lucide:chevron-down'"
				class="w-3 h-3 text-text-tertiary"
			/>
		</button>
		<p
			v-if="expanded"
			class="mt-1.5 text-xs text-text-secondary max-w-prose"
			data-testid="auth-badge-detail"
		>
			{{ result.detail }}
		</p>
	</div>
</template>
