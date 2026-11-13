<script setup lang="ts">
/**
 * One stream's readiness verdict: the kind of mail, a chip that names the
 * verdict in a word (never colour alone), the one sentence behind it and the
 * link to where it is fixed. Shared by the Delivery hub's readiness panel and
 * the compact transactional line, so both read the same.
 */
import type { StreamVerdict } from '~/utils/deliveryReadiness';
import { healthChipClass } from '~/utils/healthTone';
import { useLocalized } from '~/composables/useLocalized';
import { ArrowRightIcon } from '@coolicons/vue';

const props = withDefaults(
	defineProps<{
		verdict: StreamVerdict;
		/** The heading in front of the chip; defaults to the stream's name. */
		heading?: string;
		/** Offer the fix link. Off for viewers who cannot open the page it leads to. */
		showAction?: boolean;
	}>(),
	{ heading: undefined, showAction: true }
);

const { t } = useI18n();
const localized = useLocalized();

const resolvedHeading = computed(
	() => props.heading ?? t(`shared.deliveryReadiness.streams.${props.verdict.stream}.name`)
);
</script>

<template>
	<div
		class="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3"
		:data-testid="`stream-verdict-${verdict.stream}`"
	>
		<div class="flex items-center gap-2 shrink-0 sm:min-w-44">
			<p class="text-sm font-medium text-text-primary">{{ resolvedHeading }}</p>
			<span
				class="px-2.5 py-0.5 rounded-full text-xs font-medium shrink-0"
				:class="healthChipClass[verdict.tone]"
			>
				{{ localized(verdict.label) }}
			</span>
		</div>
		<p class="flex-1 min-w-0 text-sm text-text-secondary">{{ localized(verdict.sentence) }}</p>
		<NuxtLink
			v-if="showAction && verdict.actionHref && verdict.actionLabel"
			:to="verdict.actionHref"
			class="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline shrink-0 group"
		>
			{{ localized(verdict.actionLabel) }}
			<ArrowRightIcon
				class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform duration-(--motion-fast)"
			/>
		</NuxtLink>
	</div>
</template>
