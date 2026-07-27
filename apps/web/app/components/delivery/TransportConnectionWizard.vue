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
	RETURN_PATH_SETTLES_NOTE,
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
	stepById,
	stepIndex,
	type ReturnPathCapabilityValue,
	type TransportWizardStepId,
	type WizardFinding,
	type WizardStepStatus,
} from '~/utils/transportWizard';
import { runAlignmentProbe } from '~/utils/transportAlignmentProbe';
// Imported rather than left to Nuxt's component auto-import: these two are the
// step's content, and a mount that silently resolves them to nothing renders a
// wizard with no step 1 and no findings.
import TransportCredentialsStep from './TransportCredentialsStep.vue';
import WizardFindingRow from './WizardFindingRow.vue';

const props = defineProps<{
	/**
	 * The two arms for the sending domain being checked, from
	 * `delivery.alignmentPreflight.getAlignmentArms`. Null while loading, or when
	 * the domain has no own-MTA identity — step 3 then says so plainly instead of
	 * guessing.
	 */
	alignmentArms?: { domain: string; ownArm: AlignmentArm; reference: ReferenceArmInput } | null;
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
const currentStep = computed(() => stepById(state.value.current));
const positionLabel = computed(
	() => `Step ${currentIndex.value + 1} of ${steps.length}: ${currentStep.value.title}`
);

function setStatus(id: TransportWizardStepId, status: WizardStepStatus) {
	state.value = setStepStatus(state.value, id, status);
}

// ── Focus management ─────────────────────────────────────────────────────────
// Every transition — including opening and dismissing, which destroy the button
// that was just activated — moves focus somewhere deliberate. Without that, a
// keyboard or screen-reader user is dropped on `<body>` with no announcement.
const headingRef = ref<HTMLElement | null>(null);
const entryActionRef = ref<HTMLElement | { $el?: unknown } | null>(null);

async function focusHeading(): Promise<void> {
	await nextTick();
	headingRef.value?.focus();
}

/** The entry button is a UI-kit component, so its element is behind `$el`. */
function focusEntryAction(): void {
	const target = entryActionRef.value;
	const element: unknown = target instanceof HTMLElement ? target : (target?.$el ?? null);
	if (element instanceof HTMLElement) element.focus();
}

watch(() => state.value.current, focusHeading);

function goNext() {
	state.value = advanceStep(state.value);
}
function goBack() {
	state.value = goBackStep(state.value);
}

async function open() {
	isOpen.value = true;
	// `current` is unchanged, so the step watcher does not fire — focus the first
	// step's heading here or focus falls to `<body>`.
	await focusHeading();
}

async function dismiss() {
	isOpen.value = false;
	// The whole panel (including the button that was focused) is torn down, so
	// hand focus back to the entry action that replaces it.
	await nextTick();
	focusEntryAction();
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
	// Cleared with the findings it summarises — a stale summary must never outlive
	// them and describe a result that is no longer on screen.
	alignmentSummary.value = '';
	try {
		const result = await runAlignmentProbe(arms.ownArm, arms.reference, Date.now());
		alignmentFindingRows.value = alignmentFindings(result);
		alignmentDegradedReason.value = result.measurementDegradedReason ?? '';
		alignmentSummary.value = summarizeVerdict(result.verdict);
		setStatus('alignment', alignmentStepStatus(result));
	} catch {
		// A throw here (a malformed arm, an unexpected evaluator shape) must not
		// pin the step at `running` — a blocking step that is neither passed nor
		// resolvable strands the operator with no message and no way forward.
		// `unknown` is the honest verdict: we could not find out.
		alignmentSummary.value = 'The check could not run. Nothing has changed — try again.';
		setStatus('alignment', 'unknown');
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
				<UiButton v-if="!isOpen" ref="entryActionRef" variant="secondary" size="sm" @click="open">
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
					{{ currentStep.title }}
				</h3>
				<p class="text-sm text-text-secondary">{{ currentStep.description }}</p>
			</div>

			<!-- Step 1: credentials — its own component; the shell never sees a secret -->
			<TransportCredentialsStep
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
						<li v-for="finding in alignmentFindingRows" :key="finding.id">
							<WizardFindingRow :finding="finding" />
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
				<WizardFindingRow v-else :finding="returnPathRow" />
				<p class="text-sm text-text-secondary">{{ RETURN_PATH_SETTLES_NOTE }}</p>
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
