<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type {
	DeliverabilityAlertOperation,
	DeliverabilityCenter,
	DeliverabilityChecklistItem,
	DeliverabilityRegressionAlert,
} from '~/utils/deliverabilityCenter';
import {
	buildDeliverabilityReport,
	checklistItemDomId,
	countDeliverabilityItems,
	DELIVERABILITY_GRADE_PRESENTATION,
	findDeliverabilityItem,
	formatVerificationAge,
	itemKey,
} from '~/utils/deliverabilityCenter';
import { useDeliverabilityChecklistCopy } from '~/composables/useDeliverabilityChecklistCopy';

const { t } = useI18n();

/**
 * `utils/deliverabilityCenter` is a module-scope definition set whose grade
 * labels carry i18n keys rather than sentences (the registry convention); a
 * plain string is still accepted so a value with nothing to translate reads as
 * itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

/**
 * A check's name is shared-registry English (Convex stores and mails it with
 * regression alerts), so the toast names it through the catalog copy derived
 * from the check id. See `~/composables/useDeliverabilityChecklistCopy`.
 */
const { itemTitle } = useDeliverabilityChecklistCopy();

useHead({ title: () => t('dashboard.admin.delivery.deliverability.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

const { showToast } = useToast();
const { copy, isCopied } = useCopyToClipboard();

const {
	data: centerData,
	isLoading,
	error,
} = useOrganizationQuery(api.delivery.checklist.getCenter);

const center = computed<DeliverabilityCenter | null>(() => centerData.value ?? null);
const counts = computed(() => countDeliverabilityItems(center.value?.groups ?? []));
const grade = computed(() =>
	center.value ? DELIVERABILITY_GRADE_PRESENTATION[center.value.grade] : null
);

const activeAlertOperation = ref<DeliverabilityAlertOperation | null>(null);
const { run: acknowledgeRegressionAlert } = useBackendOperation(
	api.delivery.checklistAlertManagement.acknowledge,
	{ label: () => t('dashboard.admin.delivery.deliverability.operations.acknowledge') }
);
const { run: resolveRegressionAlert } = useBackendOperation(
	api.delivery.checklistAlertManagement.resolve,
	{ label: () => t('dashboard.admin.delivery.deliverability.operations.resolve') }
);

async function updateRegressionAlert(
	alert: DeliverabilityRegressionAlert,
	kind: DeliverabilityAlertOperation['kind']
) {
	activeAlertOperation.value = { alertId: alert.id, kind };
	try {
		const result =
			kind === 'acknowledge'
				? await acknowledgeRegressionAlert({ alertId: alert.id })
				: await resolveRegressionAlert({ alertId: alert.id });
		if (result.ok) {
			showToast(
				kind === 'acknowledge'
					? t('dashboard.admin.delivery.deliverability.toasts.acknowledged')
					: t('dashboard.admin.delivery.deliverability.toasts.resolved'),
				'success'
			);
		}
	} finally {
		activeAlertOperation.value = null;
	}
}

async function openRegressionCheck(alert: DeliverabilityRegressionAlert) {
	if (!center.value) return;
	const item = findDeliverabilityItem(center.value.groups, alert);
	if (!item) {
		showToast(t('dashboard.admin.delivery.deliverability.toasts.checkGone'), 'warning');
		return;
	}
	await nextTick();
	const details = document.getElementById(checklistItemDomId(item));
	if (!details) return;
	if (details.tagName === 'DETAILS') {
		(details as HTMLDetailsElement).open = true;
	}
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	details.scrollIntoView({
		behavior: reducedMotion ? 'auto' : 'smooth',
		block: 'center',
	});
	(details.querySelector('summary') as HTMLElement | null)?.focus({ preventScroll: true });
}

const verifyingItemKey = ref<string | null>(null);
const { run: verifyNow } = useBackendOperation(api.delivery.checklistVerification.verifyNow, {
	label: () => t('dashboard.admin.delivery.deliverability.operations.verify'),
	type: 'action',
});

async function verify(item: DeliverabilityChecklistItem) {
	verifyingItemKey.value = itemKey(item.scope, item.id);
	try {
		const result = await verifyNow({
			itemId: item.id,
			...(item.scope.kind === 'domain' ? { domainId: item.scope.domainId } : {}),
		});
		if (!result.ok) return;
		if (result.result.status === 'pass') {
			showToast(
				t('dashboard.admin.delivery.deliverability.toasts.itemVerified', {
					title: itemTitle(item),
				}),
				'success'
			);
		} else if (result.result.status === 'pending-dns') {
			showToast(t('dashboard.admin.delivery.deliverability.toasts.pendingDns'));
		} else {
			showToast(t('dashboard.admin.delivery.deliverability.toasts.needsAttention'), 'warning');
		}
	} finally {
		verifyingItemKey.value = null;
	}
}

const { run: startLoopback, isLoading: isStartingLoopback } = useBackendOperation(
	api.delivery.checklistLoopback.start,
	{ label: () => t('dashboard.admin.delivery.deliverability.operations.proof'), type: 'action' }
);

async function startProof(domainId: Id<'domains'>) {
	const result = await startLoopback({ domainId });
	if (!result.ok) return;
	showToast(
		result.result.status === 'passed'
			? t('dashboard.admin.delivery.deliverability.toasts.proofPassed')
			: result.result.status === 'sending' || result.result.status === 'awaiting_inbound'
				? t('dashboard.admin.delivery.deliverability.toasts.proofSending')
				: t('dashboard.admin.delivery.deliverability.toasts.proofFailed'),
		result.result.status === 'passed'
			? 'success'
			: result.result.status === 'failed' || result.result.status === 'timed_out'
				? 'warning'
				: 'info'
	);
}

async function copyReport() {
	if (!center.value) return;
	const copied = await copy(buildDeliverabilityReport(center.value), 'deliverability-report');
	showToast(
		copied
			? t('dashboard.admin.delivery.deliverability.toasts.reportCopied')
			: t('dashboard.admin.delivery.deliverability.toasts.reportCopyFailed'),
		copied ? 'success' : 'error'
	);
}
</script>

<template>
	<div class="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
		<header class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
			<div class="flex items-start gap-3">
				<UiIconBox icon="lucide:shield-check" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.admin.delivery.deliverability.title') }}
					</h1>
					<p class="mt-1 max-w-2xl text-sm text-text-secondary">
						{{ t('dashboard.admin.delivery.deliverability.lede') }}
					</p>
				</div>
			</div>
			<UiButton v-if="center" variant="ghost" size="sm" class="w-fit" @click="copyReport">
				<Icon
					:name="isCopied('deliverability-report') ? 'lucide:check' : 'lucide:clipboard-copy'"
					class="h-4 w-4"
				/>
				{{
					isCopied('deliverability-report')
						? t('dashboard.admin.delivery.deliverability.reportCopied')
						: t('dashboard.admin.delivery.deliverability.copyReport')
				}}
			</UiButton>
		</header>

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			:empty="!center"
			:error-title="t('dashboard.admin.delivery.deliverability.errorTitle')"
			:error-message="t('dashboard.admin.delivery.deliverability.errorMessage')"
			:loading-label="t('dashboard.admin.delivery.deliverability.loadingLabel')"
		>
			<template #loading>
				<div
					class="space-y-5"
					:aria-label="t('dashboard.admin.delivery.deliverability.loadingChecks')"
				>
					<div class="h-32 animate-pulse motion-reduce:animate-none rounded-xl bg-bg-surface" />
					<div class="h-80 animate-pulse motion-reduce:animate-none rounded-xl bg-bg-surface" />
					<div class="h-48 animate-pulse motion-reduce:animate-none rounded-xl bg-bg-surface" />
				</div>
			</template>
			<template #empty>
				<UiEmptyState
					icon="lucide:server-off"
					:title="t('dashboard.admin.delivery.deliverability.empty.title')"
					:description="t('dashboard.admin.delivery.deliverability.empty.description')"
				>
					<template #action>
						<UiButton to="/dashboard/admin/delivery">
							{{ t('dashboard.admin.delivery.deliverability.empty.action') }}
						</UiButton>
					</template>
				</UiEmptyState>
			</template>

			<div v-if="center" class="space-y-6">
				<section
					class="overflow-hidden rounded-(--radius-card) surface-2"
					aria-labelledby="deliverability-grade-heading"
				>
					<div
						class="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
					>
						<div class="flex items-start gap-4">
							<div
								v-if="grade"
								class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border"
								:class="grade.className"
							>
								<Icon :name="grade.icon" class="h-6 w-6" />
							</div>
							<div>
								<p
									v-if="grade"
									class="text-xs font-semibold uppercase tracking-wide text-text-tertiary"
								>
									{{ localized(grade.label) }}
								</p>
								<h2
									id="deliverability-grade-heading"
									class="mt-1 text-xl font-semibold text-text-primary"
								>
									{{ center.summary }}
								</h2>
								<p class="mt-1 text-xs text-text-tertiary">
									{{
										center.checkedAt
											? t('dashboard.admin.delivery.deliverability.latestCheck', {
													age: localized(formatVerificationAge(center.checkedAt)),
												})
											: t('dashboard.admin.delivery.deliverability.noCheckYet')
									}}
								</p>
							</div>
						</div>

						<dl class="grid grid-cols-3 gap-2 text-center sm:min-w-72">
							<div class="rounded-lg bg-success/8 px-3 py-2">
								<dt class="text-xs text-text-secondary">
									{{ t('dashboard.admin.delivery.deliverability.counts.verified') }}
								</dt>
								<dd class="mt-0.5 text-lg font-semibold tabular-nums text-success">
									{{ counts.passing }}
								</dd>
							</div>
							<div class="rounded-lg bg-warning/8 px-3 py-2">
								<dt class="text-xs text-text-secondary">
									{{ t('dashboard.admin.delivery.deliverability.counts.attention') }}
								</dt>
								<dd class="mt-0.5 text-lg font-semibold tabular-nums text-warning">
									{{ counts.attention }}
								</dd>
							</div>
							<div class="rounded-lg bg-brand/8 px-3 py-2">
								<dt class="text-xs text-text-secondary">
									{{ t('dashboard.admin.delivery.deliverability.counts.checking') }}
								</dt>
								<dd class="mt-0.5 text-lg font-semibold tabular-nums text-brand">
									{{ counts.pending }}
								</dd>
							</div>
						</dl>
					</div>
				</section>

				<DeliveryDeliverabilityRegressionAlerts
					:alerts="center.alerts"
					:groups="center.groups"
					:active-operation="activeAlertOperation"
					@view="openRegressionCheck"
					@acknowledge="updateRegressionAlert($event, 'acknowledge')"
					@resolve="updateRegressionAlert($event, 'resolve')"
				/>

				<DeliveryDeliverabilityNextActionCard
					:item="center.nextItem"
					:is-verifying="
						center.nextItem
							? verifyingItemKey === itemKey(center.nextItem.scope, center.nextItem.id)
							: false
					"
					@verify="verify"
				/>

				<!-- The checks above are about what your DNS says; this is about what
				     the ramp controller is doing with your traffic. It reads for itself
				     and states its own faults, so the checklist query this page's
				     boundary speaks for stays the only thing it speaks for. -->
				<DeliveryRampNarrativeCard />

				<DeliveryDeliverabilityChecklistGroups
					:groups="center.groups"
					:verifying-item-key="verifyingItemKey"
					@verify="verify"
				/>

				<DeliveryDeliverabilityLoopbackCard
					:domains="center.loopback.domains"
					:is-starting="isStartingLoopback"
					@start="startProof"
				/>
			</div>
		</UiQueryBoundary>
	</div>
</template>
