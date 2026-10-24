/**
 * Bring a settings deep link's target into view and outline it briefly.
 *
 * A palette result lands on `path#anchor`. Nuxt does not scroll to a hash that
 * was present when the page mounted, and on a Workspace page the target often
 * renders only after the page's own query answers, so the element may not
 * exist yet. This waits for it (bounded), then scrolls and marks it with
 * `data-settings-flash`, which the global stylesheet outlines. The attribute
 * sits on the element itself: `:target` would miss every in-app navigation,
 * because the router changes the hash with `pushState`.
 *
 * DOM-only (no Vue), so the wait and the flash expiry are testable with fake
 * timers. The caller validates `anchor` against a registry first; this never
 * decides which ids are allowed.
 */

export const SETTINGS_FLASH_ATTRIBUTE = 'data-settings-flash';

/** How long a missing target is waited for before the reveal gives up. */
const WAIT_MS = 10_000;
/** How long the outline stays on. */
const FLASH_MS = 2_000;

export interface SettingsRevealOptions {
	reducedMotion?: boolean;
}

/** Reveal `anchor` in `doc`. Returns a cancel that stops waiting and clears the flash. */
export function revealSettingsAnchor(
	doc: Document,
	anchor: string,
	options: SettingsRevealOptions = {}
): () => void {
	let observer: MutationObserver | null = null;
	let giveUp: ReturnType<typeof setTimeout> | null = null;
	let unflash: ReturnType<typeof setTimeout> | null = null;
	let flashed: HTMLElement | null = null;

	const stopWaiting = () => {
		observer?.disconnect();
		observer = null;
		if (giveUp !== null) clearTimeout(giveUp);
		giveUp = null;
	};

	const clearFlash = () => {
		if (unflash !== null) clearTimeout(unflash);
		unflash = null;
		flashed?.removeAttribute(SETTINGS_FLASH_ATTRIBUTE);
		flashed = null;
	};

	const reveal = (target: HTMLElement) => {
		stopWaiting();
		flashed = target;
		target.setAttribute(SETTINGS_FLASH_ATTRIBUTE, '');
		target.scrollIntoView({
			behavior: options.reducedMotion ? 'auto' : 'smooth',
			block: 'start',
		});
		unflash = setTimeout(clearFlash, FLASH_MS);
	};

	const present = doc.getElementById(anchor);
	if (present) {
		reveal(present);
	} else if (doc.body) {
		observer = new MutationObserver(() => {
			const arrived = doc.getElementById(anchor);
			if (arrived) reveal(arrived);
		});
		observer.observe(doc.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['id'],
		});
		giveUp = setTimeout(stopWaiting, WAIT_MS);
	}

	return () => {
		stopWaiting();
		clearFlash();
	};
}
