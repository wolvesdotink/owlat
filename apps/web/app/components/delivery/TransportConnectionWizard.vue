<script setup lang="ts">
/**
 * "Connect an email provider" — the guided four-step transport wizard (P2-4).
 *
 * An OFFER, never a to-do item (plan D2). It renders collapsed as a plain
 * surface card; nothing about it is a warning, an error or a "setup incomplete"
 * badge, and abandoning it half way leaves the deployment exactly as it was.
 *
 * Everything it does is the SHIPPED path:
 *   1. credentials → `TransportCredentialsStep.vue`, which drives the sealed
 *      `/api/delivery/apply-transport` env patch (no second credential model,
 *      D4). The shell learns only WHETHER the step settled — a secret never
 *      reaches this component at all.
 *   2. live send test → the shipped `DeliveryTestSendCard`, mounted here rather
 *      than reimplemented, advancing the step from its `result` event.
 *   3. alignment → the shipped dual-transport pre-flight run against live DNS,
 *      which runs the shipped SPF-coexistence detector (RFC 7208 10-lookup
 *      accounting included). Every failure names the exact DNS change to make.
 *   4. return path → P2-3's recorded capability. Informational, never blocking.
 *
 * The DECISION logic is pure and lives in `~/utils/transportWizard`; the DNS
 * gather is `~/utils/transportAlignmentProbe`. This file is the shell: the step
 * rail, focus management and the live-DNS check.
 *
 * Accessibility: one `<h3>` per step, focused on every transition so a screen
 * reader lands on the new step; an `aria-live` position announcement; the step
 * rail marked with `aria-current="step"`; every input labelled; every error in a
 * `role="alert"` region.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type {
	AlignmentArm,
	AlignmentPreflightResult,
	ReferenceArmInput,
} from '@owlat/shared/deliverabilityAlignment';
import {
	TRANSPORT_WIZARD_ENTRY,
	TRANSPORT_WIZARD_STEPS,
	advanceStep,
	alignmentFindings,
	alignmentStepStatus,
	canAdvance,
	canGoBack,
	createTransportWizardState,
	goBackStep,
	isLastStep,
	returnPathFinding,
	returnPathStepStatus,
	setStepStatus,
	skippingWizardImpact,
	stepIndex,
	type ReturnPathCapabilityValue,
	type TransportWizardStepId,
	type WizardFinding,
	type WizardStepStatus,
} from '~/utils/transportWizard';
import { runAlignmentProbe } from '~/utils/transportAlignmentProbe';

const props = defineProps<{
	/**
	 * The two arms for the sending domain being checked, from
	 * `delivery.alignmentPreflight.getAlignmentArms`. Null while loading, or when
	 * the domain has no own-MTA identity — step 3 then says so plainly instead of
	 * guessing.
	 */
	alignmentArms?: { ownArm: AlignmentArm; reference: ReferenceArmInput } | null;
	/** P2-3's recorded posture for the configured transport; null while loading. */
	returnPathCapability?: ReturnPathCapabilityValue | null;
	/** Whether a test send is possible at all (a transport is configured). */
	canSend?: boolean;
}>();

const emit = defineEmits<{ applied: [] }>();

const isOpen = ref(false);
const state = ref(createTransportWizardState());
const skipImpact = skippingWizardImpact();

const steps = TRANSPORT_WIZARD_STEPS;
const currentIndex = computed(() => stepIndex(state.value.current));
const currentStep = computed(() => steps[currentIndex.value] ?? steps[0]);
const positionLabel = computed(
	() => `Step ${currentIndex.value + 1} of ${steps.length}: ${currentStep.value?.title ?? ''}`
);

function setStatus(id: TransportWizardStepId, status: WizardStepStatus) {
	state.value = setStepStatus(state.value, id, status);
}

// ── Focus management ─────────────────────────────────────────────────────────
const headingRef = ref<HTMLElement | null>(null);

watch(
	() => state.value.current,
	async () => {
		await nextTick();
		headingRef.value?.focus();
	}
);

function goNext() {
	state.value = advanceStep(state.value);
}
function goBack() {
	state.value = goBackStep(state.value);
}

function open() {
	isOpen.value = true;
}
function dismiss() {
	isOpen.value = false;
}

// ── Step 1: credentials (its own component) ──────────────────────────────────
function onCredentialsSettled(result: { ok: boolean }) {
	setStatus('credentials', result.ok ? 'passed' : 'failed');
}

// ── Step 2: live send test (the shipped card) ────────────────────────────────
function onTestResult(result: { success: boolean }) {
	setStatus('test_send', result.success ? 'passed' : 'failed');
}

// ── Step 3: alignment against live DNS ───────────────────────────────────────
const alignmentChecking = ref(false);
const alignmentFindingRows = ref<WizardFinding[]>([]);
const alignmentSummary = ref('');
const alignmentDegradedReason = ref('');

function summarizeVerdict(verdict: AlignmentPreflightResult['verdict']): string {
	switch (verdict) {
		case 'single_arm':
			return 'No second transport is configured, so there is nothing to align yet.';
		case 'aligned':
			return 'Both arms are indistinguishable to the receiver apart from the sending infrastructure.';
		case 'unknown':
			return 'DNS could not be resolved for every check. Nothing is wrong yet — try again shortly.';
		case 'blocked':
			return 'Some checks did not pass. Each one below names the DNS change to make.';
	}
}

async function checkAlignment() {
	const arms = props.alignmentArms;
	if (!arms) return;
	alignmentChecking.value = true;
	setStatus('alignment', 'running');
	alignmentFindingRows.value = [];
	alignmentDegradedReason.value = '';
	try {
		const result = await runAlignmentProbe(arms.ownArm, arms.reference, Date.now());
		alignmentFindingRows.value = alignmentFindings(result);
		alignmentDegradedReason.value = result.measurementDegradedReason ?? '';
		alignmentSummary.value = summarizeVerdict(result.verdict);
		setStatus('alignment', alignmentStepStatus(result));
	} finally {
		alignmentChecking.value = false;
	}
}

// ── Step 4: return-path capability ───────────────────────────────────────────
const returnPathRow = computed<WizardFinding | null>(() =>
	props.returnPathCapability ? returnPathFinding(props.returnPathCapability) : null
);

watch(
	() => props.returnPathCapability,
	(capability) => {
		if (capability) setStatus('return_path', returnPathStepStatus(capability));
	},
	{ immediate: true }
);

const findingIcon: Record<WizardFinding['status'], string> = {
	pass: 'lucide:check-circle-2',
	fail: 'lucide:x-circle',
	unknown: 'lucide:help-circle',
	info: 'lucide:info',
};
const findingClass: Record<WizardFinding['status'], string> = {
	pass: 'text-success',
	fail: 'text-error',
	unknown: 'text-text-tertiary',
	info: 'text-text-secondary',
};
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex items-center justify-between gap-3">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:plug" size="sm" variant="surface" rounded="lg" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">
							{{ TRANSPORT_WIZARD_ENTRY.title }}
							<span class="text-sm font-normal text-text-tertiary">(optional)</span>
						</h2>
						<p class="text-sm text-text-secondary">{{ TRANSPORT_WIZARD_ENTRY.body }}</p>
					</div>
				</div>
				<UiButton v-if="!isOpen" variant="secondary" size="sm" @click="open">
					{{ TRANSPORT_WIZARD_ENTRY.actionLabel }}
				</UiButton>
			</div>
		</template>

		<div v-if="!isOpen" class="px-6 py-5">
			<p class="text-sm text-text-secondary">{{ skipImpact.note }}</p>
		</div>

		<div v-else class="p-6 space-y-6">
			<!-- Step rail -->
			<ol class="flex flex-wrap gap-x-6 gap-y-2" aria-label="Connection steps">
				<li
					v-for="(step, index) in steps"
					:key="step.id"
					class="flex items-center gap-2 text-sm"
					:aria-current="step.id === state.current ? 'step' : undefined"
					:class="
						step.id === state.current ? 'text-text-primary font-medium' : 'text-text-tertiary'
					"
				>
					<span
						class="inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs"
						:class="
							step.id === state.current
								? 'border-brand text-brand'
								: 'border-border-default text-text-tertiary'
						"
						>{{ index + 1 }}</span
					>
					{{ step.title }}
				</li>
			</ol>

			<p class="sr-only" aria-live="polite">{{ positionLabel }}</p>

			<div>
				<h3
					ref="headingRef"
					tabindex="-1"
					class="text-base font-semibold text-text-primary outline-none"
				>
					{{ currentStep?.title }}
				</h3>
				<p class="text-sm text-text-secondary">{{ currentStep?.description }}</p>
			</div>

			<!-- Step 1: credentials — its own component; the shell never sees a secret -->
			<DeliveryTransportCredentialsStep
				v-if="state.current === 'credentials'"
				@settled="onCredentialsSettled"
				@applied="emit('applied')"
			/>

			<!-- Step 2: live send test — the shipped card, not a second one -->
			<div v-if="state.current === 'test_send'">
				<DeliveryTestSendCard :can-send="canSend === true" @result="onTestResult" />
			</div>

			<!-- Step 3: alignment -->
			<div v-if="state.current === 'alignment'" class="space-y-4">
				<p v-if="!alignmentArms" class="text-sm text-text-secondary">
					No verified sending domain with an own-MTA signing identity was found, so there is nothing
					to compare yet. Verify a sending domain first.
				</p>
				<template v-else>
					<UiButton
						variant="secondary"
						:loading="alignmentChecking"
						:disabled="alignmentChecking"
						@click="checkAlignment"
					>
						{{ alignmentChecking ? 'Checking DNS…' : 'Check alignment' }}
					</UiButton>
					<p v-if="alignmentSummary" class="text-sm text-text-secondary" aria-live="polite">
						{{ alignmentSummary }}
					</p>
					<ul v-if="alignmentFindingRows.length" class="space-y-3">
						<li
							v-for="finding in alignmentFindingRows"
							:key="finding.id"
							class="flex items-start gap-3 rounded-lg border border-border-subtle p-3"
						>
							<Icon
								:name="findingIcon[finding.status]"
								class="w-4 h-4 mt-0.5 shrink-0"
								:class="findingClass[finding.status]"
							/>
							<div class="min-w-0">
								<p class="text-sm font-medium text-text-primary">{{ finding.label }}</p>
								<p class="text-sm text-text-secondary">{{ finding.detail }}</p>
								<p v-if="finding.remedy" class="text-sm text-text-primary mt-1">
									{{ finding.remedy }}
								</p>
							</div>
						</li>
					</ul>
					<p v-if="alignmentDegradedReason" class="text-sm text-text-secondary">
						{{ alignmentDegradedReason }}
					</p>
				</template>
			</div>

			<!-- Step 4: return-path capability -->
			<div v-if="state.current === 'return_path'" class="space-y-3">
				<p v-if="!returnPathRow" class="text-sm text-text-secondary">
					Reading the recorded return-path capability…
				</p>
				<div v-else class="flex items-start gap-3 rounded-lg border border-border-subtle p-3">
					<Icon
						:name="findingIcon[returnPathRow.status]"
						class="w-4 h-4 mt-0.5 shrink-0"
						:class="findingClass[returnPathRow.status]"
					/>
					<div class="min-w-0">
						<p class="text-sm font-medium text-text-primary">{{ returnPathRow.label }}</p>
						<p class="text-sm text-text-secondary">{{ returnPathRow.detail }}</p>
					</div>
				</div>
			</div>

			<!-- Navigation -->
			<div class="flex flex-wrap items-center gap-3 border-t border-border-subtle pt-5">
				<UiButton variant="ghost" :disabled="!canGoBack(state)" @click="goBack">Back</UiButton>
				<UiButton v-if="!isLastStep(state)" :disabled="!canAdvance(state)" @click="goNext">
					Next
				</UiButton>
				<UiButton variant="ghost" @click="dismiss">
					{{ isLastStep(state) ? 'Done' : TRANSPORT_WIZARD_ENTRY.dismissLabel }}
				</UiButton>
			</div>
		</div>
	</UiCard>
</template>
