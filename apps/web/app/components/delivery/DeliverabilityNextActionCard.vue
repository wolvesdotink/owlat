<script setup lang="ts">
import type { DeliverabilityChecklistItem } from '~/utils/deliverabilityCenter';
import DeliverabilitySetupValues from './DeliverabilitySetupValues.vue';
import DeliverabilityGuidance from './DeliverabilityGuidance.vue';
import {
	DELIVERABILITY_STATUS_PRESENTATION,
	formatRecheckCountdown,
	formatVerificationAge,
	itemKey,
} from '~/utils/deliverabilityCenter';
import { useDeliverabilityChecklistCopy } from '~/composables/useDeliverabilityChecklistCopy';

const props = defineProps<{
	item: DeliverabilityChecklistItem | null;
	isVerifying?: boolean;
}>();

const emit = defineEmits<{
	verify: [item: DeliverabilityChecklistItem];
}>();

const { t } = useI18n();

/**
 * `formatVerificationAge` carries an i18n key plus the number it interpolates
 * (the registry convention for module-scope sentences); rendered unresolved it
 * paints the serialized object at the operator instead of "3 minutes ago".
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

/**
 * The check's name and impact are shared-registry English (the diagnostic dump
 * and the mailed regression alert print them), so the German comes from a key
 * derived from the check id. See `~/composables/useDeliverabilityChecklistCopy`.
 */
const { itemTitle, itemImpact } = useDeliverabilityChecklistCopy();

const { copy, isCopied } = useCopyToClipboard();
const clock = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
	timer = setInterval(() => {
		clock.value = Date.now();
	}, 1_000);
});
onUnmounted(() => clearInterval(timer));

const status = computed(() =>
	props.item ? DELIVERABILITY_STATUS_PRESENTATION[props.item.status] : null
);
const scopedItemKey = computed(() => (props.item ? itemKey(props.item.scope, props.item.id) : ''));
const nextCheckLabel = computed(() => {
	const nextCheckAt = props.item?.verification?.nextCheckAt;
	return nextCheckAt ? formatRecheckCountdown(nextCheckAt, clock.value) : null;
});

async function copyValue(value: string, key: string) {
	await copy(value, key);
}
</script>

<template>
	<UiCard
		v-if="item"
		id="deliverability-next-action"
		padding="none"
		overflow="hidden"
		class="border-brand/25"
	>
		<div class="border-b border-border-subtle bg-brand/5 px-5 py-3 sm:px-6">
			<p class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand">
				<Icon name="lucide:arrow-right-circle" class="h-4 w-4" />
				{{ t('components.delivery.deliverabilityNextActionCard.doThisNext') }}
			</p>
		</div>

		<div class="space-y-5 p-5 sm:p-6">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div class="min-w-0">
					<h2 class="text-xl font-semibold text-text-primary">{{ itemTitle(item) }}</h2>
					<p class="mt-1 text-sm text-text-tertiary">
						{{ item.protocol }}
						<span v-if="item.scope.kind === 'domain'"> · {{ item.scope.domain }}</span>
						<span v-else>
							·
							{{ t('components.delivery.deliverabilityNextActionCard.thisServer') }}</span
						>
					</p>
				</div>
				<span
					v-if="status"
					class="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
					:class="status.className"
					role="status"
				>
					<Icon
						:name="status.icon"
						class="h-3.5 w-3.5"
						:class="{ 'animate-spin': item.status === 'pending-dns' }"
					/>
					{{ t(status.label) }}
				</span>
			</div>

			<div
				class="rounded-lg border p-4"
				:class="
					item.status === 'pending-dns'
						? 'border-brand/20 bg-brand/5'
						: 'border-border-subtle bg-bg-surface'
				"
			>
				<template v-if="item.status === 'pending-dns'">
					<p class="font-medium text-text-primary">
						{{ t('components.delivery.deliverabilityNextActionCard.pendingTitle') }}
					</p>
					<I18nT
						v-if="nextCheckLabel"
						keypath="components.delivery.deliverabilityNextActionCard.pendingBodyWithCountdown"
						tag="p"
						scope="global"
						class="mt-1 text-sm text-text-secondary"
					>
						<template #countdown>
							<span class="tabular-nums">{{ nextCheckLabel }}</span>
						</template>
					</I18nT>
					<p v-else class="mt-1 text-sm text-text-secondary">
						{{ t('components.delivery.deliverabilityNextActionCard.pendingBody') }}
					</p>
				</template>
				<template v-else>
					<p class="text-sm leading-6 text-text-primary">{{ itemImpact(item) }}</p>
					<p v-if="item.failureReason" class="mt-2 text-sm font-medium text-error">
						{{ item.failureReason }}
					</p>
					<p v-if="item.nextStep" class="mt-2 text-sm text-text-secondary">
						{{ item.nextStep }}
					</p>
				</template>
				<I18nT
					v-if="item.observed.length"
					keypath="components.delivery.deliverabilityNextActionCard.lastObserved"
					tag="p"
					scope="global"
					class="mt-2 break-words text-xs text-text-tertiary"
				>
					<template #values>
						<span class="font-mono">{{ item.observed.join(' · ') }}</span>
					</template>
				</I18nT>
			</div>

			<DeliverabilitySetupValues
				v-if="item.setupValues?.length"
				:setup-values="item.setupValues"
				:scope-key="scopedItemKey"
			/>

			<DeliverabilityGuidance
				v-if="item.instructions"
				:instructions="item.instructions"
				:scope-key="scopedItemKey"
			/>

			<div
				class="flex flex-col gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center"
			>
				<UiButton
					:loading="isVerifying"
					:disabled="isVerifying || !!item.lockedReason"
					@click="emit('verify', item)"
				>
					<template #iconLeft>
						<Icon v-if="!isVerifying" name="lucide:refresh-cw" class="h-4 w-4" />
					</template>
					{{
						item.status === 'pending-dns'
							? t('components.delivery.deliverabilityNextActionCard.checkAgain')
							: t('components.delivery.deliverabilityNextActionCard.verifyNow')
					}}
				</UiButton>
				<p v-if="item.lockedReason" class="text-xs text-text-secondary">
					{{ item.lockedReason }}
				</p>
				<p v-else-if="item.lastCheckedAt" class="text-xs text-text-tertiary">
					{{ localized(formatVerificationAge(item.lastCheckedAt, clock)) }}
				</p>
				<div class="sm:ml-auto flex flex-wrap items-center gap-3">
					<button
						type="button"
						class="text-sm text-text-secondary hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
						@click="copyValue(item.diagnosticReport, `${scopedItemKey}:diagnostic`)"
					>
						{{
							isCopied(`${scopedItemKey}:diagnostic`)
								? t('components.delivery.deliverabilityNextActionCard.diagnosticCopied')
								: t('components.delivery.deliverabilityNextActionCard.copyDiagnostic')
						}}
					</button>
					<a
						:href="item.docsHref"
						target="_blank"
						rel="noopener noreferrer"
						class="text-sm text-text-secondary hover:text-brand"
					>
						{{ t('components.delivery.deliverabilityNextActionCard.howThisWorks') }}
					</a>
				</div>
			</div>
		</div>
	</UiCard>

	<UiCard v-else class="border-success/25 bg-success/5">
		<div class="flex items-start gap-4">
			<UiIconBox icon="lucide:party-popper" size="lg" variant="success" rounded="xl" />
			<div>
				<p class="text-xs font-semibold uppercase tracking-wide text-success">
					{{ t('components.delivery.deliverabilityNextActionCard.complete.eyebrow') }}
				</p>
				<h2 class="mt-1 text-xl font-semibold text-text-primary">
					{{ t('components.delivery.deliverabilityNextActionCard.complete.title') }}
				</h2>
				<p class="mt-1 text-sm text-text-secondary">
					{{ t('components.delivery.deliverabilityNextActionCard.complete.body') }}
				</p>
			</div>
		</div>
	</UiCard>
</template>
