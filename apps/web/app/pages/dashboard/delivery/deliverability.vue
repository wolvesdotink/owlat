<script setup lang="ts">
import { api } from "@owlat/api";
import type { Id } from "@owlat/api/dataModel";
import type {
	DeliverabilityAlertOperation,
	DeliverabilityCenter,
	DeliverabilityChecklistItem,
	DeliverabilityRegressionAlert,
} from "~/utils/deliverabilityCenter";
import {
	buildDeliverabilityReport,
	checklistItemDomId,
	countDeliverabilityItems,
	DELIVERABILITY_GRADE_PRESENTATION,
	findDeliverabilityItem,
	formatVerificationAge,
	itemKey,
} from "~/utils/deliverabilityCenter";

useHead({ title: "Deliverability — Owlat" });

definePageMeta({
	layout: "dashboard",
	middleware: "auth",
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
	center.value ? DELIVERABILITY_GRADE_PRESENTATION[center.value.grade] : null,
);

const activeAlertOperation = ref<DeliverabilityAlertOperation | null>(null);
const { run: acknowledgeRegressionAlert } = useBackendOperation(
	api.delivery.checklistAlertManagement.acknowledge,
	{ label: "Acknowledge deliverability regression" },
);
const { run: resolveRegressionAlert } = useBackendOperation(
	api.delivery.checklistAlertManagement.resolve,
	{ label: "Resolve deliverability regression" },
);

async function updateRegressionAlert(
	alert: DeliverabilityRegressionAlert,
	kind: DeliverabilityAlertOperation["kind"],
) {
	activeAlertOperation.value = { alertId: alert.id, kind };
	try {
		const result =
			kind === "acknowledge"
				? await acknowledgeRegressionAlert({ alertId: alert.id })
				: await resolveRegressionAlert({ alertId: alert.id });
		if (result) {
			showToast(
				kind === "acknowledge" ? "Regression acknowledged" : "Regression resolved",
				"success",
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
		showToast("This check is no longer part of the active sending setup", "warning");
		return;
	}
	await nextTick();
	const details = document.getElementById(checklistItemDomId(item));
	if (!details) return;
	if (details.tagName === "DETAILS") {
		(details as HTMLDetailsElement).open = true;
	}
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	details.scrollIntoView({
		behavior: reducedMotion ? "auto" : "smooth",
		block: "center",
	});
	(details.querySelector("summary") as HTMLElement | null)?.focus({ preventScroll: true });
}

const verifyingItemKey = ref<string | null>(null);
const { run: verifyNow } = useBackendOperation(api.delivery.checklistVerification.verifyNow, {
	label: "Verify deliverability check",
	type: "action",
});

async function verify(item: DeliverabilityChecklistItem) {
	verifyingItemKey.value = itemKey(item.scope, item.id);
	try {
		const result = await verifyNow({
			itemId: item.id,
			...(item.scope.kind === "domain" ? { domainId: item.scope.domainId } : {}),
		});
		if (!result) return;
		if (result.status === "pass") {
			showToast(`${item.title} is verified`, "success");
		} else if (result.status === "pending-dns") {
			showToast("We’ll keep checking while DNS spreads");
		} else {
			showToast("The check still needs attention", "warning");
		}
	} finally {
		verifyingItemKey.value = null;
	}
}

const { run: startLoopback, isLoading: isStartingLoopback } = useBackendOperation(
	api.delivery.checklistLoopback.start,
	{ label: "Run deliverability proof", type: "action" },
);

async function startProof(domainId: Id<"domains">) {
	const result = await startLoopback({ domainId });
	if (!result) return;
	showToast(
		result.status === "passed"
			? "End-to-end proof passed"
			: result.status === "sending" || result.status === "awaiting_inbound"
				? "Probe sent — waiting for the receiving check"
				: "The end-to-end proof found a problem",
		result.status === "passed"
			? "success"
			: result.status === "failed" || result.status === "timed_out"
				? "warning"
				: "info",
	);
}

async function copyReport() {
	if (!center.value) return;
	const copied = await copy(buildDeliverabilityReport(center.value), "deliverability-report");
	showToast(
		copied ? "Setup report copied" : "Could not copy the report",
		copied ? "success" : "error",
	);
}
</script>

<template>
	<div class="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
		<header class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
			<div class="flex items-start gap-3">
				<UiIconBox icon="lucide:shield-check" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Deliverability</h1>
					<p class="mt-1 max-w-2xl text-sm text-text-secondary">
						See what is healthy, fix the most important issue next, and verify every change with a
						live check.
					</p>
				</div>
			</div>
			<button
				v-if="center"
				type="button"
				class="inline-flex w-fit items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-surface hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
				@click="copyReport"
			>
				<Icon
					:name="isCopied('deliverability-report') ? 'lucide:check' : 'lucide:clipboard-copy'"
					class="h-4 w-4"
				/>
				{{ isCopied("deliverability-report") ? "Report copied" : "Copy setup report" }}
			</button>
		</header>

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			:empty="!center"
			error-title="Couldn’t load deliverability"
			error-message="The live checks could not be loaded. Try again before changing your setup."
			loading-label="Loading live deliverability checks…"
		>
			<template #loading>
				<div class="space-y-5" aria-label="Loading deliverability checks">
					<div class="h-32 animate-pulse rounded-xl bg-bg-surface" />
					<div class="h-80 animate-pulse rounded-xl bg-bg-surface" />
					<div class="h-48 animate-pulse rounded-xl bg-bg-surface" />
				</div>
			</template>
			<template #empty>
				<UiEmptyState
					icon="lucide:server-off"
					title="No sending setup found"
					description="Configure a delivery provider and a sending domain, then return here for the live checklist."
				>
					<NuxtLink to="/dashboard/delivery/setup" class="btn btn-primary">
						Open delivery setup
					</NuxtLink>
				</UiEmptyState>
			</template>

			<div v-if="center" class="space-y-6">
				<section
					class="overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
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
									{{ grade.label }}
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
											? `Latest live check ${formatVerificationAge(center.checkedAt)}`
											: "No live check has completed yet"
									}}
								</p>
							</div>
						</div>

						<dl class="grid grid-cols-3 gap-2 text-center sm:min-w-72">
							<div class="rounded-lg bg-success/8 px-3 py-2">
								<dt class="text-xs text-text-secondary">Verified</dt>
								<dd class="mt-0.5 text-lg font-semibold tabular-nums text-success">
									{{ counts.passing }}
								</dd>
							</div>
							<div class="rounded-lg bg-warning/8 px-3 py-2">
								<dt class="text-xs text-text-secondary">Attention</dt>
								<dd class="mt-0.5 text-lg font-semibold tabular-nums text-warning">
									{{ counts.attention }}
								</dd>
							</div>
							<div class="rounded-lg bg-brand/8 px-3 py-2">
								<dt class="text-xs text-text-secondary">Checking</dt>
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
