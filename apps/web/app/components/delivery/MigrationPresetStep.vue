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

const { t } = useI18n();

/**
 * The migration table is module scope and never calls `useI18n`: it hands back
 * catalog keys, and this step is the render boundary that turns them into words.
 */
type MigrationMessage = string | { key: string; params?: Record<string, unknown> };
const message = (value: MigrationMessage): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

const { run: setRoute } = useBackendOperation(api.providerRoutes.setRoute, {
	label: () => t('components.delivery.migrationPresetStep.applyRouteOperation'),
});
const { run: setStreamPreset } = useBackendOperation(api.delivery.rampControls.setStreamPreset, {
	label: () => t('components.delivery.migrationPresetStep.setPaceOperation'),
});

const isApplying = ref(false);
/**
 * The writes that landed, in order, so a partial apply is legible. Each is named
 * by the key it renders under plus the stream it was for, so a locale switch
 * re-words a list that is already on screen.
 */
interface AppliedWrite {
	readonly key: string;
	readonly stream: string;
}
const applied = ref<AppliedWrite[]>([]);
const failedAt = ref<AppliedWrite | null>(null);

const writeLabel = (write: AppliedWrite): string => t(write.key, { stream: write.stream });

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
			const write: AppliedWrite = {
				key: 'components.delivery.migrationPresetStep.routeWrite',
				stream: payload.messageType,
			};
			// `run` resolves `ok: false` on failure and has already surfaced why.
			if (!result.ok) {
				failedAt.value = write;
				return;
			}
			applied.value = [...applied.value, write];
		}
		for (const stream of MIGRATION_MESSAGE_TYPES) {
			const result = await setStreamPreset({ stream, preset: MIGRATION_RAMP_PRESET });
			const write: AppliedWrite = {
				key: 'components.delivery.migrationPresetStep.paceWrite',
				stream,
			};
			if (!result.ok) {
				failedAt.value = write;
				return;
			}
			applied.value = [...applied.value, write];
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
			<I18nT
				keypath="components.delivery.migrationPresetStep.bulletStreams"
				tag="li"
				scope="global"
			>
				<template #streams>
					<strong>{{ t('components.delivery.migrationPresetStep.bulletStreamsNames') }}</strong>
				</template>
				<template #strategy>
					<code>adaptive_mix</code>
				</template>
			</I18nT>
			<li>{{ t('components.delivery.migrationPresetStep.bulletFallback') }}</li>
			<I18nT keypath="components.delivery.migrationPresetStep.bulletPace" tag="li" scope="global">
				<template #pace>
					<strong>{{ t('components.delivery.migrationPresetStep.bulletPaceName') }}</strong>
				</template>
			</I18nT>
			<I18nT keypath="components.delivery.migrationPresetStep.bulletStart" tag="li" scope="global">
				<template #share>
					<strong>0%</strong>
				</template>
			</I18nT>
		</ul>

		<DeliveryReferenceRelayNotice />

		<p v-if="relayWarning" class="text-sm text-warning" data-testid="migration-relay-warning">
			{{ message(relayWarning) }}
		</p>

		<p v-if="preflight" class="text-sm text-error" data-testid="migration-preset-preflight">
			{{ message(preflight) }}
		</p>

		<div class="flex items-center gap-3">
			<UiButton :disabled="!canApply" data-testid="migration-preset-apply" @click="apply">
				{{
					isApplied
						? t('components.delivery.migrationPresetStep.reapply')
						: t('components.delivery.migrationPresetStep.apply')
				}}
			</UiButton>
			<span v-if="isApplying" class="text-sm text-text-secondary">{{
				t('components.delivery.migrationPresetStep.applying')
			}}</span>
		</div>

		<ul
			v-if="applied.length"
			class="text-sm text-success space-y-1"
			data-testid="migration-preset-applied"
		>
			<li v-for="entry in applied" :key="`${entry.key}:${entry.stream}`">
				{{
					t('components.delivery.migrationPresetStep.appliedEntry', { write: writeLabel(entry) })
				}}
			</li>
		</ul>

		<p v-if="failedAt" class="text-sm text-error" data-testid="migration-preset-failure">
			{{ t('components.delivery.migrationPresetStep.stoppedAt', { write: writeLabel(failedAt) }) }}
		</p>
	</div>
</template>
