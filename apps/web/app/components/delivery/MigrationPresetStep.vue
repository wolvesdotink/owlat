<script setup lang="ts">
/**
 * The one-click migration preset.
 *
 * WHAT IT WRITES (plan §10, D8): all three message types onto `adaptive_mix`
 * over `[mta, mandrill]` with Mandrill as the deliverability-fallback relay, and
 * all three streams onto the `conservative` ramp preset. Six writes, composed on
 * the client from two shipped mutations rather than hidden behind a seventh: a
 * "migration preset" mutation would have to re-implement `setRoute`'s five
 * refusals and `setStreamPreset`'s audit entry, and the composition is the only
 * thing that is actually new.
 *
 * SIX WRITES, NOT ONE TRANSACTION. Each is applied in order and reported by
 * name, and the sequence stops at the first refusal — so a preset that fails
 * half-way says which half landed instead of leaving the operator to diff two
 * screens. The pre-flight below asks the backend's own question
 * (`fallbackRelayIssue`) first, which is what keeps that case rare.
 *
 * The D8 warning is not a blocker. A second enabled relay does not make the
 * write invalid; it degrades alignment confidence, which holds the ramp at 0%
 * while everything looks healthy. That is a judgement for the operator, stated
 * plainly, next to the alignment plane's own notice.
 */
import { api } from '@owlat/api';
import {
	competingRelayWarning,
	MIGRATION_MESSAGE_TYPES,
	MIGRATION_RAMP_PRESET,
	migrationPresetIssue,
	migrationRoutePayloads,
	type MigrationRouteView,
	type MigrationTransportEntry,
} from '~/utils/mandrillMigration';

const props = defineProps<{
	readonly catalog: readonly MigrationTransportEntry[] | null;
	readonly routes: readonly MigrationRouteView[] | null;
	readonly isApplied: boolean;
	readonly isBlocked?: boolean;
	readonly blockedReason?: string | null;
}>();

const emit = defineEmits<{ (event: 'applied'): void }>();

const { run: setRoute } = useBackendOperation(api.providerRoutes.setRoute, {
	label: 'Apply the migration route',
});
const { run: setStreamPreset } = useBackendOperation(api.delivery.rampControls.setStreamPreset, {
	label: 'Set the ramp pace',
});

const isApplying = ref(false);
/** The writes that landed, in order, so a partial apply is legible. */
const applied = ref<string[]>([]);
const failedAt = ref<string | null>(null);

const preflight = computed(() => migrationPresetIssue(props.catalog));
const relayWarning = computed(() => competingRelayWarning(props.routes));
const canApply = computed(
	() => props.isBlocked !== true && !isApplying.value && preflight.value === null
);

async function apply(): Promise<void> {
	isApplying.value = true;
	applied.value = [];
	failedAt.value = null;
	try {
		for (const payload of migrationRoutePayloads(props.catalog)) {
			const result = await setRoute({
				messageType: payload.messageType,
				strategy: payload.strategy,
				providers: payload.providers.map((provider) => ({ ...provider })),
				deliverabilityFallback: { ...payload.deliverabilityFallback },
			});
			// `run` returns undefined on failure and has already surfaced why.
			if (result === undefined) {
				failedAt.value = `${payload.messageType} route`;
				return;
			}
			applied.value = [...applied.value, `${payload.messageType} route`];
		}
		for (const stream of MIGRATION_MESSAGE_TYPES) {
			const result = await setStreamPreset({ stream, preset: MIGRATION_RAMP_PRESET });
			if (result === undefined) {
				failedAt.value = `${stream} ramp pace`;
				return;
			}
			applied.value = [...applied.value, `${stream} ramp pace`];
		}
		emit('applied');
	} finally {
		isApplying.value = false;
	}
}
</script>

<template>
	<div class="space-y-4" data-testid="migration-preset-step">
		<p v-if="isBlocked" class="text-sm text-warning" data-testid="migration-preset-blocked">
			{{ blockedReason }}
		</p>

		<ul class="text-sm text-text-secondary space-y-1 list-disc pl-5">
			<li>
				<strong>Transactional, campaign and automation</strong> all move to the measured split
				(<code>adaptive_mix</code>) over your own MTA and Mailchimp Transactional.
			</li>
			<li>Mailchimp Transactional becomes the deliverability-fallback relay for each of them.</li>
			<li>
				Every stream ramps at the <strong>conservative</strong> pace — smaller steps, more clean
				windows per step. You can change it later on the ramp controls screen.
			</li>
			<li>
				Your own MTA starts at <strong>0%</strong> of traffic. Nothing about today's delivery
				changes; Owlat starts measuring both arms on identical instrumentation.
			</li>
		</ul>

		<DeliveryReferenceRelayNotice />

		<p v-if="relayWarning" class="text-sm text-warning" data-testid="migration-relay-warning">
			{{ relayWarning }}
		</p>

		<p v-if="preflight" class="text-sm text-error" data-testid="migration-preset-preflight">
			{{ preflight }}
		</p>

		<div class="flex items-center gap-3">
			<UiButton :disabled="!canApply" data-testid="migration-preset-apply" @click="apply">
				{{ isApplied ? 'Re-apply the migration preset' : 'Apply the migration preset' }}
			</UiButton>
			<span v-if="isApplying" class="text-sm text-text-secondary">Applying…</span>
		</div>

		<ul
			v-if="applied.length"
			class="text-sm text-success space-y-1"
			data-testid="migration-preset-applied"
		>
			<li v-for="entry in applied" :key="entry">{{ entry }} applied</li>
		</ul>

		<p v-if="failedAt" class="text-sm text-error" data-testid="migration-preset-failure">
			Stopped at the {{ failedAt }}. Everything listed above is already in place — fix the problem
			above and apply again; re-applying what landed is harmless.
		</p>
	</div>
</template>
