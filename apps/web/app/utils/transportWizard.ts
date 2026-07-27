/**
 * "Connect your ESP" — the transport connection wizard's PURE core (P2-4).
 *
 * Four steps, in the only order that makes sense:
 *
 *  1. CREDENTIALS — entered through the SHIPPED transport editor path
 *     (`useSetupWizard`'s validators + `buildProviderEnv` + the sealed
 *     `/api/delivery/apply-transport` endpoint). No second credential model
 *     (D4), and no secret ever comes back out.
 *  2. LIVE SEND TEST — the SHIPPED `DeliveryTestSendCard` machinery, mounted
 *     inside the step rather than reimplemented beside it.
 *  3. ALIGNMENT — the SHIPPED dual-transport pre-flight
 *     (`@owlat/shared/deliverabilityAlignment`) run against LIVE DNS, which in
 *     turn runs the SHIPPED SPF coexistence detector including its RFC 7208
 *     10-lookup accounting. The two arms must be indistinguishable to the
 *     receiver in everything except the sending infrastructure (D11).
 *  4. RETURN-PATH PROBE — the recorded capability from P2-3. Informational by
 *     construction: an ESP that cannot carry our VERP return path lowers
 *     measurement confidence and NOTHING else.
 *
 * D2 — THE ADDITIVE-ONLY THIRD-PARTY RULE. This whole flow is an OFFER. Never
 * starting it, or abandoning it half way, leaves the deployment fully
 * functional in standalone mode: no warning, no error, no "setup incomplete"
 * state anywhere in the delivery UI. That is what {@link TRANSPORT_WIZARD_ENTRY}
 * and {@link skippingWizardImpact} exist to state in one place a test can hold
 * the UI to.
 *
 * Pure (D15): no clock, no DNS, no Convex, no Vue. Every input is a parameter,
 * every transition returns a NEW state. The live-DNS gather is its sibling
 * `transportAlignmentProbe.ts`; the rendering is
 * `components/delivery/TransportConnectionWizard.vue`.
 */

import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type {
	AlignmentCheckId,
	AlignmentCheckResult,
	AlignmentPreflightResult,
} from '@owlat/shared/deliverabilityAlignment';

const TRANSPORT_WIZARD_STEP_IDS = ['credentials', 'test_send', 'alignment', 'return_path'] as const;

export type TransportWizardStepId = (typeof TRANSPORT_WIZARD_STEP_IDS)[number];

/**
 * A step's status. `unknown` is the DNS-could-not-answer state carried up from
 * the alignment pre-flight — it is neither a pass nor a failure, and it must
 * never be laundered into either (the pre-flight's whole point).
 */
export type WizardStepStatus = 'not_started' | 'running' | 'passed' | 'failed' | 'unknown';

interface TransportWizardStep {
	readonly id: TransportWizardStepId;
	readonly title: string;
	/** One line of step-level copy, in the delivery screens' voice. */
	readonly description: string;
	/**
	 * Whether a non-passing result stops the operator moving on. Only the first
	 * three are: the return-path probe RECORDS a capability, and a relay that
	 * cannot carry our return path is a supported configuration with coarser
	 * bounce attribution (P2-3), not a failure to fix.
	 */
	readonly blocking: boolean;
}

export const TRANSPORT_WIZARD_STEPS: readonly TransportWizardStep[] = [
	{
		id: 'credentials',
		title: 'Credentials',
		description: 'Enter the provider credentials. They are sealed on the server and never shown.',
		blocking: true,
	},
	{
		id: 'test_send',
		title: 'Live send test',
		description: 'Send one real message through the transport you just configured.',
		blocking: true,
	},
	{
		id: 'alignment',
		title: 'SPF, DKIM & DMARC alignment',
		description:
			'Check live DNS so both arms look identical to the receiver apart from the infrastructure.',
		blocking: true,
	},
	{
		id: 'return_path',
		title: 'Return-path capability',
		description: 'Record whether this provider can carry our own bounce address.',
		blocking: false,
	},
];

export interface TransportWizardState {
	readonly current: TransportWizardStepId;
	readonly statuses: Readonly<Record<TransportWizardStepId, WizardStepStatus>>;
}

const FIRST_STEP_ID: TransportWizardStepId = 'credentials';

export function createTransportWizardState(): TransportWizardState {
	return {
		current: FIRST_STEP_ID,
		statuses: {
			credentials: 'not_started',
			test_send: 'not_started',
			alignment: 'not_started',
			return_path: 'not_started',
		},
	};
}

export function stepIndex(id: TransportWizardStepId): number {
	return TRANSPORT_WIZARD_STEPS.findIndex((step) => step.id === id);
}

export function stepAt(index: number): TransportWizardStep | null {
	return TRANSPORT_WIZARD_STEPS[index] ?? null;
}

/**
 * The step for an id — TOTAL, unlike an array index. Exported because the shell
 * renders the current step's title and description, and a `| undefined` there
 * spreads optional chaining through the template for a case that cannot happen.
 */
export function stepById(id: TransportWizardStepId): TransportWizardStep {
	const step = TRANSPORT_WIZARD_STEPS.find((candidate) => candidate.id === id);
	// The id is a member of the literal union the array is built from, so this is
	// unreachable; it exists because the array lookup is still `| undefined`.
	if (step === undefined) throw new Error(`Unknown wizard step: ${id}`);
	return step;
}

export function isLastStep(state: TransportWizardState): boolean {
	return stepIndex(state.current) === TRANSPORT_WIZARD_STEPS.length - 1;
}

/**
 * May the operator move forward? A blocking step must have PASSED; a
 * non-blocking one only has to have finished running. `unknown` on a blocking
 * step holds — the same rule the ramp's alignment gate applies, so the UI and
 * the controller can never tell the operator two different stories.
 */
export function canAdvance(state: TransportWizardState): boolean {
	if (isLastStep(state)) return false;
	const status = state.statuses[state.current];
	if (stepById(state.current).blocking) return status === 'passed';
	return status !== 'not_started' && status !== 'running';
}

/** Going BACK is always allowed except from the first step — never destructive. */
export function canGoBack(state: TransportWizardState): boolean {
	return stepIndex(state.current) > 0;
}

export function advanceStep(state: TransportWizardState): TransportWizardState {
	if (!canAdvance(state)) return state;
	const next = stepAt(stepIndex(state.current) + 1);
	return next === null ? state : { ...state, current: next.id };
}

/**
 * Step back. Statuses are DELIBERATELY preserved: an operator re-reading the
 * alignment findings must not have to re-run the live send test to get back to
 * where they were.
 */
export function goBackStep(state: TransportWizardState): TransportWizardState {
	if (!canGoBack(state)) return state;
	const previous = stepAt(stepIndex(state.current) - 1);
	return previous === null ? state : { ...state, current: previous.id };
}

export function setStepStatus(
	state: TransportWizardState,
	id: TransportWizardStepId,
	status: WizardStepStatus
): TransportWizardState {
	return { ...state, statuses: { ...state.statuses, [id]: status } };
}

/**
 * One actionable line of the results list. `remedy` is null ONLY when there is
 * nothing to do — a passing check never carries advice, and a failing one always
 * names the exact change to make (the copy comes from the shipped
 * `ALIGNMENT_REMEDIES` table, so the wizard and the readiness card say the same
 * words).
 */
export interface WizardFinding {
	readonly id: string;
	readonly label: string;
	readonly status: 'pass' | 'fail' | 'unknown' | 'info';
	readonly detail: string;
	readonly remedy: string | null;
}

/**
 * How one finding status PRESENTS — icon, colour and the word a screen reader
 * hears. One map rather than three parallel ones keyed by the same union: a
 * status added to {@link WizardFinding} then fails to compile until all three
 * are answered, and no use site can index two maps out of step.
 *
 * `srLabel` is not decoration. Without it the status is carried by a glyph and a
 * colour alone, so a screen-reader user hears "SPF" plus the detail and cannot
 * tell a pass from a failure.
 */
export interface FindingPresentation {
	readonly icon: string;
	readonly class: string;
	readonly srLabel: string;
}

export const FINDING_PRESENTATION: Readonly<Record<WizardFinding['status'], FindingPresentation>> =
	{
		pass: { icon: 'lucide:check-circle-2', class: 'text-success', srLabel: 'Passed:' },
		fail: { icon: 'lucide:x-circle', class: 'text-error', srLabel: 'Needs a change:' },
		unknown: { icon: 'lucide:help-circle', class: 'text-text-tertiary', srLabel: 'Not known:' },
		info: { icon: 'lucide:info', class: 'text-text-secondary', srLabel: 'For information:' },
	};

const ALIGNMENT_CHECK_LABELS: Readonly<Record<AlignmentCheckId, string>> = {
	from_domain: 'From domain',
	spf: 'SPF',
	dkim: 'DKIM',
	dmarc: 'DMARC',
};

function toFinding(check: AlignmentCheckResult): WizardFinding {
	return {
		id: check.id,
		label: ALIGNMENT_CHECK_LABELS[check.id],
		status: check.status,
		detail: check.detail,
		remedy: check.remedy === '' ? null : check.remedy,
	};
}

/** The four alignment checks as result rows, in the pre-flight's own order. */
export function alignmentFindings(result: AlignmentPreflightResult): WizardFinding[] {
	return result.checks.map(toFinding);
}

/**
 * The step status a pre-flight verdict implies.
 *
 * `single_arm` — no reference transport at all — is a PASS with plain copy, not
 * a warning (D2). It is reachable here when an operator opens the wizard and
 * walks to step 3 without connecting anything.
 */
export function alignmentStepStatus(result: AlignmentPreflightResult): WizardStepStatus {
	switch (result.verdict) {
		case 'aligned':
		case 'single_arm':
			return 'passed';
		case 'blocked':
			return 'failed';
		case 'unknown':
			return 'unknown';
	}
}

/**
 * The return-path posture the wizard records, DERIVED from the query that
 * answers it rather than re-declared. A fourth posture added to P2-3's resolver
 * then breaks {@link returnPathFinding}'s exhaustive switch at compile time,
 * which is the point — a hand-copied union would compile and silently render
 * nothing for it.
 */
export type ReturnPathCapabilityValue = FunctionReturnType<
	typeof api.delivery.relayReturnPath.getReturnPathReadiness
>['capability'];

/**
 * The return-path result row. NEVER a failure: the three postures are
 * "comparable measurement", "coarser measurement" and "not known yet", and each
 * one is a supported configuration. The wizard says which, plainly, and moves on.
 */
export function returnPathFinding(capability: ReturnPathCapabilityValue): WizardFinding {
	switch (capability) {
		case 'supported':
			return {
				id: 'return_path',
				label: 'Return path',
				status: 'pass',
				detail:
					'This provider carries our own bounce address, so bounces are attributed exactly like the own-MTA arm.',
				remedy: null,
			};
		case 'unsupported':
			return {
				id: 'return_path',
				label: 'Return path',
				status: 'info',
				detail:
					'This provider rewrites the bounce address, so bounce attribution on that arm is coarser. Measurement confidence is lower; sending is unaffected.',
				remedy: null,
			};
		case 'unknown':
			return {
				id: 'return_path',
				label: 'Return path',
				status: 'info',
				detail:
					'Not established yet — the probe settles after a real bounce comes back. Until then the arm is measured conservatively. Nothing is blocked.',
				remedy: null,
			};
	}
}

/**
 * WHEN this step's answer arrives, said plainly.
 *
 * The posture is OBSERVED, not asked for: P2-3's probe settles it the first time
 * a real bounce comes back through the provider. A transport connected a minute
 * ago therefore reads "not known yet" here, every time, and pretending otherwise
 * would make the step look broken. Nothing waits on it (D2).
 */
export const RETURN_PATH_SETTLES_NOTE =
	'This one is observed rather than asked for: it settles the first time a bounce comes back through this provider, so a transport you connected a moment ago reads “not known yet”. Nothing waits on it.';

/** The probe never blocks: any resolved posture finishes the step. */
export function returnPathStepStatus(capability: ReturnPathCapabilityValue): WizardStepStatus {
	return capability === 'unknown' ? 'unknown' : 'passed';
}

/**
 * The entry-point copy, in ONE place so the "offer, never a nag" rule is
 * testable rather than a convention (D2). `tone: 'offer'` is load-bearing: the
 * card renders in the neutral surface style, never the warning one.
 */
export const TRANSPORT_WIZARD_ENTRY = {
	tone: 'offer',
	isOptional: true,
	title: 'Connect an email provider',
	body: 'If you already pay for an ESP, you can send through it while your own server warms up — and compare the two. Owlat sends on its own without one; this changes nothing until you choose it.',
	actionLabel: 'Connect a provider',
	dismissLabel: 'Not now',
} as const;

/**
 * What NOT connecting a provider does to the deployment: nothing. This is the
 * D2 contract as a value, so `wizardOptional.test.ts` asserts against a single
 * source rather than against prose scattered through templates.
 */
interface WizardSkipImpact {
	readonly blocksSend: boolean;
	readonly blocksPhasePromotion: boolean;
	readonly rendersError: boolean;
	readonly rendersWarning: boolean;
	readonly marksSetupIncomplete: boolean;
	/** Plain, non-alarming line the delivery screens may show. Never a nag. */
	readonly note: string;
}

/** What a redacted credential reads as. Short, and obviously not a value. */
export const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * Strip any entered credential out of a string before it is rendered, toasted
 * or logged.
 *
 * The credential itself never leaves the sealed apply/validate request — but a
 * provider's own error message can quote back the key it rejected, and an
 * unhandled `Error` can carry a request body in its message. That is the one
 * path by which a secret could reach a screen or a console, so every operator-
 * facing string in the wizard goes through here first. Shortest secrets are
 * replaced LAST so a value that contains another one is not half-redacted.
 */
export function redactSecrets(message: string, secrets: readonly string[]): string {
	const values = [...new Set(secrets.map((secret) => secret.trim()).filter((s) => s.length >= 4))];
	values.sort((a, b) => b.length - a.length);
	let redacted = message;
	for (const value of values) redacted = redacted.split(value).join(REDACTED_PLACEHOLDER);
	return redacted;
}

export function skippingWizardImpact(): WizardSkipImpact {
	return {
		blocksSend: false,
		blocksPhasePromotion: false,
		rendersError: false,
		rendersWarning: false,
		marksSetupIncomplete: false,
		note: 'Sending through your own server only. Measurement confidence is lower without a second arm to compare against.',
	};
}
