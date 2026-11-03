<script setup lang="ts">
/**
 * The From-picker authenticity chip: shows, before any send, whether a sending
 * identity's domain is verified AND whether the active transport signs/bounces
 * it in a DMARC-aligned way. A broken identity (unverified domain or a misaligned
 * transport) renders in a warning/error tone with a plain-language reason — the
 * disable-with-reason surface the campaign wizard and Postbox composer share.
 *
 * Presentational only: it derives its whole appearance from `senderAuthDisplay`
 * (the single source of truth for the copy AND the parent's block decision), so
 * the chip and the picker's send-gate can't disagree.
 */
import type { OutboundAlignmentState } from '@owlat/shared';
import { senderAuthDisplay, type SenderAuthDisplay } from '~/utils/senderAlignment';
import { healthChipClass, healthTextClass } from '~/utils/healthTone';
import { useLocalized } from '~/composables/useLocalized';
import {
	CircleInfoIcon,
	ShieldCheckIcon,
	ShieldCloseIcon,
	ShieldIcon,
	ShieldWarningIcon,
	type IconComponent,
} from '@coolicons/vue';

const props = defineProps<{
	verified: boolean;
	alignment: OutboundAlignmentState;
	reason?: string | null;
}>();

/**
 * `senderAuthDisplay` is module scope and so never calls `useI18n`: its chip
 * label and reason arrive as catalog keys (or, for a transport's verbatim
 * reason, as the sentence itself), and this render boundary resolves them.
 */
const message = useLocalized();

const display = computed<SenderAuthDisplay>(() =>
	senderAuthDisplay({
		verified: props.verified,
		alignment: props.alignment,
		reason: props.reason ?? null,
	})
);

const ICON: Record<SenderAuthDisplay['tone'], IconComponent> = {
	success: ShieldCheckIcon,
	warning: ShieldWarningIcon,
	error: ShieldCloseIcon,
	neutral: ShieldIcon,
};
</script>

<template>
	<div>
		<span
			class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
			:class="healthChipClass[display.tone]"
		>
			<component :is="ICON[display.tone]" class="w-3.5 h-3.5 shrink-0" />
			{{ message(display.label) }}
		</span>
		<p
			v-if="display.detail"
			class="mt-1.5 flex items-start gap-1.5 text-sm"
			:class="healthTextClass[display.tone]"
		>
			<CircleInfoIcon class="w-4 h-4 mt-0.5 shrink-0" />
			<span>{{ message(display.detail) }}</span>
		</p>
	</div>
</template>
