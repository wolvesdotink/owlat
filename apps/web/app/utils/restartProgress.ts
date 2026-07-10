/**
 * Pure phase derivation for the "the app is restarting" handoff.
 *
 * Applying setup (or editing the sending transport) writes a new `.env` and the
 * running web process must restart to pick it up. The client can't watch that
 * restart directly, so it polls a readiness probe every ~2s. Left silent, that
 * poll reads as a 24-second hang before any hint appears.
 *
 * This module turns the poll's own state — how many probes have elapsed and
 * whether the probe has cleared — into an honest, phased status the UI can show
 * as it happens: applying config → restarting services → waiting for the app to
 * come back → done (or, if it drags on, a timeout affordance offering a manual
 * nudge). Kept DOM- and Nuxt-free so the mapping is unit-testable on its own.
 * Mounted by the setup review page; built for reuse by the A1 transport-editor
 * apply flow.
 */

/** The status of the restart, derived purely from the readiness poll. */
export type RestartPhase = 'applying' | 'restarting' | 'waiting' | 'done' | 'timeout';

/** The three sequential work steps shown as a stepper, in order. */
export const RESTART_STEP_ORDER = ['applying', 'restarting', 'waiting'] as const;

/** One of the three stepper steps (excludes the terminal `done`/`timeout`). */
export type RestartStep = (typeof RESTART_STEP_ORDER)[number];

/** State of the readiness poll, the only inputs the phase derives from. */
export interface RestartProgressInput {
	/** Number of readiness probes elapsed since apply (each roughly 2s apart). */
	pollCount: number;
	/** Whether the readiness probe has cleared — the app is back. */
	ready: boolean;
}

// Probe thresholds (each probe ~2s): restarting from ~4s, waiting from ~12s,
// and past ~24s we surface the manual-restart affordance while still polling.
const RESTARTING_AFTER = 2;
const WAITING_AFTER = 6;
const TIMEOUT_AFTER = 12;

/**
 * Map the readiness poll's state to the current restart phase. A cleared probe
 * always wins (`done`); otherwise the elapsed probe count walks through the
 * phases and tips into `timeout` once the restart is taking unusually long.
 */
export function restartProgressPhase({ pollCount, ready }: RestartProgressInput): RestartPhase {
	if (ready) return 'done';
	if (pollCount >= TIMEOUT_AFTER) return 'timeout';
	if (pollCount >= WAITING_AFTER) return 'waiting';
	if (pollCount >= RESTARTING_AFTER) return 'restarting';
	return 'applying';
}

/** Short label + one-line explanation for each phase, in plain language. */
export interface RestartPhaseCopy {
	label: string;
	detail: string;
}

export const RESTART_PHASE_COPY: Record<Exclude<RestartPhase, 'done'>, RestartPhaseCopy> = {
	applying: {
		label: 'Applying your configuration',
		detail: 'Writing your settings to the server.',
	},
	restarting: {
		label: 'Restarting services',
		detail: 'Loading the new configuration.',
	},
	waiting: {
		label: 'Waiting for the app to come back',
		detail: 'Almost there — reconnecting as soon as it’s online.',
	},
	timeout: {
		label: 'Taking longer than usual',
		detail: 'Still waiting for the app to come back.',
	},
};

/** Rendered state of a single stepper row. */
export type RestartStepStatus = 'complete' | 'active' | 'pending';

/**
 * How a given stepper phase should render for the current overall phase.
 * `done` completes every step; `timeout` keeps the final `waiting` step active
 * (the restart genuinely hasn't landed yet); otherwise steps before the active
 * one read complete, the active one spins, and later ones are pending.
 */
export function restartStepStatus(step: RestartStep, phase: RestartPhase): RestartStepStatus {
	if (phase === 'done') return 'complete';
	const activeStep: RestartStep = phase === 'timeout' ? 'waiting' : phase;
	const stepIdx = RESTART_STEP_ORDER.indexOf(step);
	const activeIdx = RESTART_STEP_ORDER.indexOf(activeStep);
	if (stepIdx < activeIdx) return 'complete';
	if (stepIdx === activeIdx) return 'active';
	return 'pending';
}
