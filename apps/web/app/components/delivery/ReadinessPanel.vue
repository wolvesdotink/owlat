<script setup lang="ts">
/**
 * The one delivery-readiness panel that leads the Delivery hub.
 *
 * It answers "can this instance send, and if not, what's the next thing to
 * do?" once per kind of mail: transactional mail goes out from the default
 * sender one message at a time, marketing mail is bulk mail and is held to
 * more (DMARC, one-click unsubscribe, warm-up pacing, complaint headroom). Both
 * verdicts and the gate list come from `useDeliveryReadiness`, the same fold
 * the transactional pages read, and the gates that only matter for the
 * built-in MTA appear only for a stream it carries.
 *
 * Member-readable: every source is non-secret, and the two admin-only ones are
 * read only for admins. Editing still happens on the admin-gated pages each
 * gate links to.
 */
import type { ReadinessGate, ReadinessGateStatus } from '~/utils/deliveryReadiness';
import { healthTextClass } from '~/utils/healthTone';
import { useLocalized } from '~/composables/useLocalized';
import { useDeliveryReadiness } from '~/composables/useDeliveryReadiness';
import {
	ArrowRightIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	ClockIcon,
	RocketIcon,
	type IconComponent,
} from '@coolicons/vue';

const { t } = useI18n();

/**
 * The readiness verdicts come out of `utils/deliveryReadiness`, a module-scope
 * definition set that carries i18n keys rather than sentences (the registry
 * convention); a plain string is still accepted so a value with nothing to
 * translate reads as itself.
 */
const localized = useLocalized();

const { readiness, isLoading, error: loadError, retry } = useDeliveryReadiness();

// Open gates lead; the passed ones sit one interaction away, so a ready
// instance reads as two quiet verdict lines rather than a wall of green.
const openGates = computed(() => readiness.value?.gates.filter((g) => g.status !== 'ready') ?? []);
const passedGates = computed(
	() => readiness.value?.gates.filter((g) => g.status === 'ready') ?? []
);
const showPassed = ref(false);

/** Both verdicts in one sentence, announced when a re-check changes them. */
const announcement = computed(() =>
	(readiness.value?.streams ?? [])
		.map((verdict) =>
			t('components.delivery.readinessPanel.streamAnnouncement', {
				stream: t(`shared.deliveryReadiness.streams.${verdict.stream}.name`),
				level: localized(verdict.label),
			})
		)
		.join(' ')
);

/** "Marketing only · via Amazon SES": which stream and transport a gate belongs to. */
function gateMeta(gate: ReadinessGate): string | null {
	const parts: string[] = [];
	if (gate.streams?.length === 1) {
		parts.push(
			t('components.delivery.readinessPanel.gateFor', {
				stream: t(`shared.deliveryReadiness.streams.${gate.streams[0]}.name`),
			})
		);
	}
	if (gate.transport) {
		parts.push(
			t('components.delivery.readinessPanel.via', { transport: localized(gate.transport) })
		);
	}
	return parts.length > 0 ? parts.join(' · ') : null;
}

function gateKey(gate: ReadinessGate): string {
	return `${gate.key}:${(gate.streams ?? []).join(',')}`;
}

// Per-gate glyph; the text colour reuses the shared tone → class map so it can't
// drift from the dot/chip renderings (never the brand terracotta for state).
const GATE_ICON: Record<ReadinessGateStatus, IconComponent> = {
	ready: CircleCheckIcon,
	attention: CircleWarningIcon,
	pending: ClockIcon,
};
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<!-- Loading: skeleton over spinner-only, matching the native-feel bar. -->
		<div v-if="isLoading" class="p-6 space-y-4" aria-busy="true">
			<div class="flex items-center gap-3">
				<div class="w-10 h-10 rounded-xl bg-bg-surface animate-pulse motion-reduce:animate-none" />
				<div class="flex-1 space-y-2">
					<div class="h-4 w-40 rounded bg-bg-surface animate-pulse motion-reduce:animate-none" />
					<div class="h-3 w-64 rounded bg-bg-surface animate-pulse motion-reduce:animate-none" />
				</div>
			</div>
			<div
				v-for="n in 3"
				:key="n"
				class="h-12 rounded-lg bg-bg-surface animate-pulse motion-reduce:animate-none"
			/>
		</div>

		<!-- Error -->
		<UiQueryBoundary
			v-else-if="loadError"
			:error="loadError"
			:error-message="t('components.delivery.readinessPanel.error')"
			@retry="retry"
		/>

		<div v-else-if="readiness" class="p-6 space-y-5">
			<div class="flex items-start gap-3 min-w-0">
				<UiIconBox :icon="RocketIcon" size="md" variant="brand" rounded="lg" />
				<div class="min-w-0">
					<p class="text-xs font-medium uppercase tracking-wide text-text-tertiary">
						{{ t('components.delivery.readinessPanel.eyebrow') }}
					</p>
					<h2 class="text-lg font-semibold text-text-primary mt-0.5">
						{{ t('components.delivery.readinessPanel.title') }}
					</h2>
				</div>
			</div>

			<!-- One verdict per kind of mail: what blocks receipts is not what
				 holds back a campaign. -->
			<ul
				v-if="readiness.streams.length > 0"
				class="space-y-2"
				:aria-label="t('components.delivery.readinessPanel.streamsLabel')"
			>
				<li
					v-for="verdict in readiness.streams"
					:key="verdict.stream"
					class="rounded-lg border border-border-subtle px-3 py-3"
				>
					<DeliveryStreamVerdict :verdict="verdict" />
				</li>
			</ul>
			<p class="sr-only" role="status">{{ announcement }}</p>

			<!-- The gates that are not ready, each labelled with the stream and
				 transport it belongs to. -->
			<ul v-if="openGates.length > 0" class="space-y-2" data-testid="readiness-open-gates">
				<li
					v-for="g in openGates"
					:key="gateKey(g)"
					class="flex items-start gap-3 rounded-lg bg-bg-surface px-3 py-3"
				>
					<component
						:is="GATE_ICON[g.status]"
						class="w-5 h-5 mt-0.5 shrink-0"
						:class="healthTextClass[g.tone]"
					/>
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium text-text-primary">{{ localized(g.title) }}</p>
						<p v-if="gateMeta(g)" class="text-xs text-text-tertiary mt-0.5">{{ gateMeta(g) }}</p>
						<p class="text-sm text-text-secondary mt-0.5">{{ localized(g.detail) }}</p>
					</div>
					<NuxtLink
						v-if="g.actionHref && g.actionLabel"
						:to="g.actionHref"
						class="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline shrink-0 mt-0.5 group"
					>
						{{ localized(g.actionLabel) }}
						<ArrowRightIcon
							class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform duration-(--motion-fast)"
						/>
					</NuxtLink>
				</li>
			</ul>

			<UiDisclosure
				v-if="passedGates.length > 0"
				v-model="showPassed"
				:label="t('components.delivery.readinessPanel.passedChecks', { count: passedGates.length })"
			>
				<ul class="space-y-2" data-testid="readiness-passed-gates">
					<li
						v-for="g in passedGates"
						:key="gateKey(g)"
						class="flex items-start gap-3 rounded-lg bg-bg-surface px-3 py-3"
					>
						<component
							:is="GATE_ICON[g.status]"
							class="w-5 h-5 mt-0.5 shrink-0"
							:class="healthTextClass[g.tone]"
						/>
						<div class="flex-1 min-w-0">
							<p class="text-sm font-medium text-text-primary">{{ localized(g.title) }}</p>
							<p v-if="gateMeta(g)" class="text-xs text-text-tertiary mt-0.5">
								{{ gateMeta(g) }}
							</p>
							<p class="text-sm text-text-secondary mt-0.5">{{ localized(g.detail) }}</p>
						</div>
					</li>
				</ul>
			</UiDisclosure>
		</div>
	</UiCard>
</template>
