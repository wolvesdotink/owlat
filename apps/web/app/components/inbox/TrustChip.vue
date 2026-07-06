<script setup lang="ts">
import { useClickOutside } from '~/composables/useClickOutside';
import type { TrustLabel } from '~/utils/trustLabel';

/**
 * Human trust chip for agent-drafted replies: "Ready to send" / "Worth a look"
 * / "Needs you" instead of raw confidence percentages and flag enums.
 *
 * Click (or Enter/Space — it's a real button) opens a small popover listing
 * the plain-language reasons, with the underlying numbers kept as a quiet
 * text-tertiary footer for power users — progressive disclosure, not deletion.
 * Escape and outside clicks close it. Purely presentational.
 */
const props = defineProps<{
	trust: TrustLabel;
	/** Optional extra quiet footer line, e.g. "Classifier confidence 45%". */
	extraDetail?: string;
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);

useClickOutside(rootRef, () => {
	if (open.value) open.value = false;
});
const handleEscape = (event: KeyboardEvent) => {
	if (event.key === 'Escape') open.value = false;
};
watch(open, (isOpen) => {
	if (isOpen) document.addEventListener('keydown', handleEscape);
	else document.removeEventListener('keydown', handleEscape);
});
onUnmounted(() => document.removeEventListener('keydown', handleEscape));

const VARIANT_CLASS: Record<TrustLabel['variant'], string> = {
	success: 'bg-success/10 text-success',
	warning: 'bg-warning/10 text-warning',
	error: 'bg-error/10 text-error',
};
</script>

<template>
	<span ref="rootRef" class="relative inline-flex">
		<button
			type="button"
			data-testid="trust-chip"
			class="inline-flex items-center text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
			:class="VARIANT_CLASS[props.trust.variant]"
			:aria-expanded="open"
			:aria-label="`${props.trust.label} — see why`"
			@click.stop.prevent="open = !open"
		>
			{{ props.trust.label }}
		</button>
		<div
			v-if="open"
			data-testid="trust-chip-popover"
			role="dialog"
			:aria-label="props.trust.label"
			class="absolute left-0 top-full mt-1 z-20 w-64 rounded-lg border border-border-subtle bg-bg-elevated shadow-lg p-3 text-left"
			@click.stop
		>
			<p class="text-xs font-medium text-text-primary">{{ props.trust.label }}</p>
			<ul data-testid="trust-chip-reasons" class="mt-1.5 space-y-1">
				<li
					v-for="reason in props.trust.reasons"
					:key="reason"
					class="flex items-start gap-1.5 text-xs text-text-secondary"
				>
					<span
						class="mt-1.5 h-1 w-1 rounded-full bg-current opacity-60 shrink-0"
						aria-hidden="true"
					/>
					<span>{{ reason }}</span>
				</li>
			</ul>
			<p
				data-testid="trust-chip-detail"
				class="mt-2 pt-2 border-t border-border-subtle text-[11px] text-text-tertiary tabular-nums"
			>
				{{ props.trust.detail
				}}<template v-if="props.extraDetail"> · {{ props.extraDetail }}</template>
			</p>
		</div>
	</span>
</template>
