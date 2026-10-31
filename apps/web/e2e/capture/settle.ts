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

export interface PageChecks {
	/** Why the page can never become the requested shot (sign-in, an error page), or null. */
	blocker(): Promise<string | null>;
	/** Fonts loaded and no loading placeholder visible, at this moment. */
	loaded(): Promise<boolean>;
	/** Waits up to {@link SETTLE_TIMEOUT_MS} for `loaded`; false if it never held. */
	waitLoaded(): Promise<boolean>;
	/** Waits for {@link QUIET_MS} without DOM changes; false if the page kept changing. */
	waitQuiet(): Promise<boolean>;
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
		if (!(await checks.waitQuiet())) {
			throw new CaptureFailure(
				`${name}: the page kept changing for ${SETTLE_TIMEOUT_MS / 1000}s; nothing to capture reliably.`
			);
		}
		await checks.paint();
		const image = await checks.screenshot();
		await refuseBlocked(name, checks);
		if (await checks.loaded()) return image;
	}
	throw new CaptureFailure(
		`${name}: a loading placeholder came back after every quiet period; nothing to capture reliably.`
	);
}
