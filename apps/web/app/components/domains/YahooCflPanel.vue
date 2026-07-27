<script setup lang="ts">
/**
 * Yahoo Complaint Feedback Loop — the guided enrollment panel (piece P4-6).
 *
 * Yahoo's CFL is DKIM-DOMAIN based: there is no API and no credential, only a
 * bilateral enrollment the operator performs on Yahoo's sender site. So this is
 * a GUIDED FLOW, not an integration screen — four steps, each stating exactly
 * what to do and how to tell it worked, plus the two controls that record what
 * the operator did (`Submit` / `Confirm`) and one that starts over.
 *
 * D2 (additive-only third-party rule) drives the whole visual grammar: a domain
 * that never enrolls is `not_started`, which is a SUPPORTED CONFIGURATION. It
 * renders as a calm unstarted option — no warning badge, no error, no
 * "setup incomplete" nag — and the panel states which complaint signal the yahoo
 * cell is running on instead, with the confidence caveat spelled out (D14: an
 * honest weak signal beats a confident wrong one). `lapsed` is a prompt to
 * re-check at Yahoo, styled like every other to-do, never like a failure.
 *
 * Every decision shown here is DERIVED by the backend's pure core
 * (`@owlat/shared/yahooCfl`): this component renders `getGuide` and never
 * recomputes a status of its own, so the panel can never disagree with the row.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	domainId: Id<'domains'>;
	/** Whether the current member may change domain settings. */
	canManage: boolean;
}>();

// `getGuide` is admin-gated on the backend (`organization:manage`), so a member
// who cannot manage domains must not subscribe at all — otherwise the query
// rejects with `forbidden` and the row would surface an error for a panel they
// simply may not see. Conditional-args pattern (matches MtaStsModeCard).
const { data: guide } = useConvexQuery(api.domains.yahooCfl.getGuide, () =>
	props.canManage ? { domainId: props.domainId } : 'skip'
);

const { run: submitEnrollment, isLoading: isSubmitting } = useBackendOperation(
	api.domains.yahooCfl.submitEnrollment,
	{ label: 'Record Yahoo CFL submission' }
);
const { run: confirmEnrollment, isLoading: isConfirming } = useBackendOperation(
	api.domains.yahooCfl.confirmEnrollment,
	{ label: 'Confirm Yahoo CFL enrollment' }
);
const { run: resetEnrollment, isLoading: isResetting } = useBackendOperation(
	api.domains.yahooCfl.resetEnrollment,
	{ label: 'Reset Yahoo CFL enrollment' }
);

const isBusy = computed(() => isSubmitting.value || isConfirming.value || isResetting.value);

/** Calm, factual state copy. None of these four is an error state. */
const STATE_LABELS = {
	not_started: 'Not enrolled',
	awaiting_yahoo: 'Waiting for Yahoo',
	enrolled: 'Enrolled',
	lapsed: 'Worth re-checking',
} as const;

const STATE_CLASSES = {
	not_started: 'bg-surface-subtle text-text-secondary',
	awaiting_yahoo: 'bg-surface-subtle text-text-secondary',
	enrolled: 'bg-success/10 text-success',
	lapsed: 'bg-surface-subtle text-text-secondary',
} as const;

const state = computed(() => guide.value?.state ?? null);
const stateLabel = computed(() => (state.value ? STATE_LABELS[state.value] : ''));
const stateClass = computed(() => (state.value ? STATE_CLASSES[state.value] : ''));

// Step affordance icons. `blocked` is "not your turn yet", not "something broke".
const STEP_ICONS = {
	done: 'lucide:check-circle-2',
	in_progress: 'lucide:loader',
	todo: 'lucide:circle',
	blocked: 'lucide:lock',
} as const;

const STEP_CLASSES = {
	done: 'text-success',
	in_progress: 'text-text-secondary',
	todo: 'text-text-secondary',
	blocked: 'text-text-tertiary',
} as const;

// Which controls make sense right now, derived from the same state the steps are.
const canSubmit = computed(
	() => props.canManage && (state.value === 'not_started' || state.value === 'lapsed')
);
const canConfirm = computed(() => props.canManage && state.value === 'awaiting_yahoo');
const canReset = computed(
	() => props.canManage && state.value !== null && state.value !== 'not_started'
);
// Yahoo will not accept an enrollment for a domain it cannot see our signature
// on, so Submit stays disabled until the domain is verified AND signing. This
// gates only the WIZARD — mail to Yahoo keeps flowing either way.
const isDkimReady = computed(
	() => guide.value?.precondition.isVerified === true && !!guide.value?.precondition.dkimSelector
);

async function submit() {
	await submitEnrollment({ domainId: props.domainId });
}
async function confirm() {
	await confirmEnrollment({ domainId: props.domainId });
}
async function reset() {
	await resetEnrollment({ domainId: props.domainId });
}
</script>

<template>
	<div v-if="guide" class="pt-2" data-testid="yahoocfl-panel">
		<div class="flex items-center justify-between gap-3">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider">
				Yahoo complaint feedback loop
			</p>
			<span
				class="text-xs px-2 py-0.5 rounded-full"
				:class="stateClass"
				data-testid="yahoocfl-state"
			>
				{{ stateLabel }}
			</span>
		</div>

		<p class="mt-1 text-sm text-text-secondary">
			Yahoo reports spam complaints to senders who enroll the DKIM domain they sign with. Enrolling
			is optional — it measures Yahoo complaints directly instead of standing in for them.
		</p>

		<!-- The four guided steps. Each states what to do AND how to tell it worked. -->
		<ol class="mt-3 space-y-3" data-testid="yahoocfl-steps">
			<li
				v-for="step in guide.steps"
				:key="step.id"
				class="flex items-start gap-2"
				:data-testid="`yahoocfl-step-${step.id}`"
				:data-status="step.status"
			>
				<Icon
					:name="STEP_ICONS[step.status]"
					class="w-4 h-4 mt-0.5 shrink-0"
					:class="STEP_CLASSES[step.status]"
				/>
				<div class="min-w-0">
					<p class="text-sm font-medium text-text-primary">{{ step.title }}</p>
					<p class="text-xs text-text-secondary mt-0.5">{{ step.action }}</p>
					<p class="text-xs text-text-tertiary mt-0.5">
						<span class="font-medium">How to tell it worked:</span> {{ step.verification }}
					</p>
					<a
						v-if="step.link"
						:href="step.link"
						target="_blank"
						rel="noopener noreferrer"
						class="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
						:data-testid="`yahoocfl-link-${step.id}`"
					>
						Open Yahoo's enrollment form
						<Icon name="lucide:external-link" class="w-3 h-3" />
					</a>
				</div>
			</li>
		</ol>

		<!-- The controls that record what the operator actually did. -->
		<div v-if="canManage" class="mt-3 flex flex-wrap items-center gap-2">
			<button
				v-if="canSubmit"
				type="button"
				class="btn btn-primary text-sm py-1.5 px-3"
				data-testid="yahoocfl-submit"
				:disabled="isBusy || !isDkimReady"
				:title="isDkimReady ? undefined : 'Verify the DKIM domain first'"
				@click="submit"
			>
				{{ isSubmitting ? 'Saving…' : "I submitted Yahoo's form" }}
			</button>
			<button
				v-if="canConfirm"
				type="button"
				class="btn btn-primary text-sm py-1.5 px-3"
				data-testid="yahoocfl-confirm"
				:disabled="isBusy"
				@click="confirm"
			>
				{{ isConfirming ? 'Saving…' : 'Yahoo accepted the domain' }}
			</button>
			<button
				v-if="canReset"
				type="button"
				class="btn btn-secondary text-sm py-1.5 px-3"
				data-testid="yahoocfl-reset"
				:disabled="isBusy"
				@click="reset"
			>
				{{ isResetting ? 'Saving…' : 'Start over' }}
			</button>
		</div>

		<!-- D14: say the quiet part. Which signal the yahoo cell actually runs on,
		     and how confident it is. A caveat, never a warning and never a nag. -->
		<p class="mt-3 text-xs text-text-tertiary" data-testid="yahoocfl-confidence">
			<template v-if="guide.complaintSignal.caveat">{{ guide.complaintSignal.caveat }}</template>
			<template v-else>
				Measurement confidence: high — Yahoo complaints for this domain are measured directly.
			</template>
		</p>
	</div>
</template>
