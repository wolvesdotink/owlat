/**
 * Per-sender zoom of a mail body in the Postbox reader: one sender's 11px
 * newsletter can read larger without growing every other message.
 *
 * Device-local like the reading-comfort settings (utils/readingComfort): the
 * right zoom depends on the screen in front of you, so it lives in this
 * browser's localStorage and never syncs. Stored as one object of sender key
 * (utils/postboxImageAllowlist `postboxSenderKey`) to percent; a sender at
 * 100% has no entry.
 *
 * Pure data and pure functions, so the steps and the storage format are
 * unit-tested without a DOM.
 */

/** The zoom steps, in percent. */
export const SENDER_ZOOM_STEPS: readonly number[] = [80, 90, 100, 110, 125, 150, 175, 200];

export const SENDER_ZOOM_DEFAULT = 100;

/** localStorage key of the per-sender zooms. */
export const SENDER_ZOOM_STORAGE_KEY = 'owlat-sender-zoom';

/**
 * Most senders kept. Past it the sender zoomed longest ago is forgotten, so
 * years of one-off zooms cannot grow the entry without bound.
 */
export const SENDER_ZOOM_LIMIT = 500;

/** Sender key → percent, oldest change first. */
export type SenderZooms = Readonly<Record<string, number>>;

export type SenderZoomAction = 'zoomIn' | 'zoomOut' | 'zoomReset';

/** Keep only entries that are a sender key and an offered step other than 100%. */
export function resolveSenderZooms(stored: unknown): SenderZooms {
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
	const zooms: Record<string, number> = {};
	for (const [sender, percent] of Object.entries(stored)) {
		if (!sender || typeof percent !== 'number') continue;
		if (percent === SENDER_ZOOM_DEFAULT || !SENDER_ZOOM_STEPS.includes(percent)) continue;
		zooms[sender] = percent;
	}
	return zooms;
}

/** Parse the raw localStorage string; malformed JSON keeps nothing. */
export function parseSenderZooms(raw: string | null): SenderZooms {
	if (raw === null) return {};
	try {
		return resolveSenderZooms(JSON.parse(raw));
	} catch {
		return {};
	}
}

/** The step one up or down from `percent`, or 100% for a reset. Clamped at the ends. */
export function nextSenderZoom(percent: number, action: SenderZoomAction): number {
	if (action === 'zoomReset') return SENDER_ZOOM_DEFAULT;
	if (action === 'zoomIn') {
		return SENDER_ZOOM_STEPS.find((step) => step > percent) ?? SENDER_ZOOM_STEPS.at(-1)!;
	}
	return SENDER_ZOOM_STEPS.findLast((step) => step < percent) ?? SENDER_ZOOM_STEPS[0]!;
}

/** True when `action` would leave `percent` where it is. */
export function senderZoomAtLimit(percent: number, action: SenderZoomAction): boolean {
	return nextSenderZoom(percent, action) === percent;
}

/**
 * `zooms` with `sender` set to `percent`. The changed sender moves to the end
 * (newest), 100% removes it, and the oldest entries go past the limit.
 */
export function withSenderZoom(
	zooms: SenderZooms,
	sender: string,
	percent: number,
	limit = SENDER_ZOOM_LIMIT
): SenderZooms {
	const next: Record<string, number> = { ...zooms };
	delete next[sender];
	if (percent !== SENDER_ZOOM_DEFAULT) next[sender] = percent;
	const senders = Object.keys(next);
	for (const old of senders.slice(0, Math.max(0, senders.length - limit))) delete next[old];
	return next;
}
