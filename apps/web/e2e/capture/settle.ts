/**
 * When a page counts as loaded enough to become a shot, with the browser
 * checks passed in so the order is tested without a browser. Every condition
 * is checked again after the screenshot: a late part can mount a loading
 * placeholder, or the session can end, and then leave the DOM quiet, so a
 * check made only before the quiet period would accept that frame.
 */

import { CaptureFailure } from './surfaces';

export const SETTLE_TIMEOUT_MS = 30_000;
/** How long the DOM must stay unchanged before a shot. */
export const QUIET_MS = 1_500;
/**
 * How many screenshots a page may invalidate (a placeholder showing up again
 * after the DOM went quiet) before it is reported instead of waited out.
 */
export const SETTLE_ATTEMPTS = 5;
/**
 * How long a loaded page may keep changing before its timers are frozen. A
 * live countdown or a ticking clock changes the DOM every second and would
 * never let it go quiet; anything that is not driven by a timer (data
 * arriving) still has to stop before the shot. Not frozen at once, because a
 * transition that has just started needs its animation frames to finish.
 */
export const TICK_GRACE_MS = 5_000;

export interface PageChecks {
	/** Why the page can never become the requested shot (sign-in, an error page), or null. */
	blocker(): Promise<string | null>;
	/** Fonts loaded and no loading placeholder visible, at this moment. */
	loaded(): Promise<boolean>;
	/** Waits up to {@link SETTLE_TIMEOUT_MS} for `loaded`; false if it never held. */
	waitLoaded(): Promise<boolean>;
	/** Waits for {@link QUIET_MS} without DOM changes; false if the page kept changing for `timeoutMs`. */
	waitQuiet(timeoutMs: number): Promise<boolean>;
	/** Stops the page's clock: no timer, interval or animation frame of the app fires. */
	freezeTimers(): Promise<void>;
	/** Lets the page's clock run again. */
	thawTimers(): Promise<void>;
	/** Resolves once the current DOM has been painted. */
	paint(): Promise<void>;
	screenshot(): Promise<Uint8Array>;
}

async function refuseBlocked(name: string, checks: PageChecks): Promise<void> {
	const blocker = await checks.blocker();
	if (blocker) throw new CaptureFailure(`${name}: ${blocker}`);
}

/** The screenshot of a loaded page, or a CaptureFailure saying why there is none. */
export async function shootWhenSettled(name: string, checks: PageChecks): Promise<Uint8Array> {
	let frozen = false;
	try {
		for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
			await refuseBlocked(name, checks);
			if (!(await checks.waitLoaded())) {
				throw new CaptureFailure(
					`${name}: the page was still loading after ${SETTLE_TIMEOUT_MS / 1000}s.`
				);
			}
			// Not every late part has a placeholder (a sidebar list, a picker that
			// shows an empty note until its options arrive), so also wait for the DOM
			// to stop changing. A page that never does is reported, not captured midway.
			let quiet = await checks.waitQuiet(TICK_GRACE_MS);
			if (!quiet) {
				await checks.freezeTimers();
				frozen = true;
				quiet = await checks.waitQuiet(SETTLE_TIMEOUT_MS);
			}
			if (!quiet) {
				throw new CaptureFailure(
					`${name}: the page kept changing for ${SETTLE_TIMEOUT_MS / 1000}s, also with its ` +
						'timers frozen; nothing to capture reliably.'
				);
			}
			await checks.paint();
			const image = await checks.screenshot();
			await refuseBlocked(name, checks);
			if (await checks.loaded()) return image;
			// The placeholder may be waiting on a timer, so the next attempt starts
			// with the clock running again.
			if (frozen) {
				frozen = false;
				await checks.thawTimers();
			}
		}
		throw new CaptureFailure(
			`${name}: a loading placeholder came back after every quiet period; nothing to capture reliably.`
		);
	} finally {
		if (frozen) await checks.thawTimers();
	}
}
