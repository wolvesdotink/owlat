<script setup lang="ts">
/**
 * The delivery strip (plan idea 1): what actually happened to a message we sent,
 * one row per recipient, under the message in the thread reader.
 *
 * Until this existed, `mailMessages.outbound` was written by the outbound
 * lifecycle module and read by nothing — a hard bounce and a delivered mail were
 * pixel-identical in the reader, forever. The strip is a pure view over that
 * existing data: no new state, no writer, nothing it can get wrong except the
 * words, and those come from two module-scope registries
 * (`utils/postboxDeliveryStrip`, `utils/postboxBounceCatalog`) that are tested
 * without mounting anything.
 *
 * The failed-recipients-only resend is emitted, not performed: the composer
 * stack belongs to the reader, and this component stays free of it so it mounts
 * in a test with nothing but an i18n instance.
 */
import { formatTime, formatDateTime } from '~/utils/formatters';
import { healthTextClass } from '~/utils/healthTone';
import { bounceFaultKey, type BounceExplanation } from '~/utils/postboxBounceCatalog';
import {
	deliveryStripView,
	isDeliveryStripWorthShowing,
	resendTargets,
	type OutboundDelivery,
} from '~/utils/postboxDeliveryStrip';
import type { LocalizedText } from '~/utils/readinessGate';

const props = defineProps<{ delivery: OutboundDelivery }>();

const emit = defineEmits<{
	/** Resend this message to the failed recipients only (original spelling). */
	resend: [addresses: string[]];
}>();

const { t, locale } = useI18n();

/** Registry keys in, sentences out — this component is the render boundary. */
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

const view = computed(() => deliveryStripView(props.delivery));
const isWorthShowing = computed(() => isDeliveryStripWorthShowing(view.value));
const targets = computed(() => resendTargets(view.value));

function faultLabel(explanation: BounceExplanation): string {
	return t(bounceFaultKey(explanation.fault));
}

function onResend() {
	if (targets.value.length > 0) emit('resend', targets.value);
}
</script>

<template>
	<section
		v-if="isWorthShowing"
		class="mt-3 rounded-lg border border-border-subtle overflow-hidden"
		:aria-label="t('components.postbox.postboxDeliveryStrip.regionLabel')"
	>
		<ul class="divide-y divide-border-subtle">
			<li v-for="row in view.rows" :key="row.idx" class="px-3 py-2">
				<div class="flex items-start gap-2 text-xs">
					<Icon
						:name="row.icon"
						class="w-3.5 h-3.5 mt-0.5 shrink-0"
						:class="healthTextClass[row.tone]"
					/>
					<div class="min-w-0 flex-1">
						<p class="flex flex-wrap items-baseline gap-x-1.5">
							<span class="font-medium text-text-primary break-all">{{ row.address }}</span>
							<span :class="healthTextClass[row.tone]">{{ localized(row.label) }}</span>
							<span
								v-if="row.at !== null"
								class="text-text-tertiary"
								:title="formatDateTime(row.at, locale)"
								>{{ formatTime(row.at, locale) }}</span
							>
						</p>

						<!-- The plain-language half (idea 2). Cause, then whose problem it
						     is, then exactly one next action — never the raw SMTP line as
						     the headline. -->
						<template v-if="row.explanation">
							<p class="mt-0.5 text-text-secondary">
								{{ localized(row.explanation.summary) }}
							</p>
							<p class="mt-0.5 text-text-tertiary">
								<span>{{ faultLabel(row.explanation) }}</span>
								<template v-if="row.explanation.action">
									·
									<span>{{ localized(row.explanation.action) }}</span>
								</template>
							</p>
							<!-- The receiver's own words, kept as evidence rather than as the
							     explanation. Collapsed so it never competes with the line above. -->
							<details v-if="row.rawDetail" class="mt-1">
								<summary
									class="cursor-pointer text-text-tertiary hover:text-text-secondary select-none"
								>
									{{ t('components.postbox.postboxDeliveryStrip.showServerReply') }}
								</summary>
								<p class="mt-1 font-mono text-[11px] leading-snug text-text-tertiary break-words">
									{{ row.rawDetail }}
								</p>
							</details>
						</template>
					</div>
				</div>
			</li>
		</ul>

		<div v-if="targets.length > 0" class="px-3 py-2 bg-bg-surface">
			<button
				type="button"
				class="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline"
				@click="onResend"
			>
				<Icon name="lucide:send-horizontal" class="w-3.5 h-3.5" />
				{{
					targets.length === 1
						? t('components.postbox.postboxDeliveryStrip.resendOne', { address: targets[0] })
						: t('components.postbox.postboxDeliveryStrip.resendMany', { count: targets.length })
				}}
			</button>
		</div>
	</section>
</template>
