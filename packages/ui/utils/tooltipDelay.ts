/**
 * The delay every UiTooltip shares.
 *
 * A pointer resting on a control waits `TOOLTIP_OPEN_DELAY_MS` before its
 * tooltip opens, so sweeping across a toolbar does not flash a label under
 * every icon. Once one tooltip is showing, the person is reading labels: the
 * next trigger they reach opens at once, and so does any trigger reached within
 * `TOOLTIP_WARM_MS` of the last tooltip closing. Only one tooltip shows at a
 * time; opening one closes the other.
 *
 * Module state, not per-app: it is only ever written from pointer and focus
 * handlers, which run in the browser, so a server render never reads or
 * writes it and nothing leaks between requests.
 */
export const TOOLTIP_OPEN_DELAY_MS = 500;
export const TOOLTIP_WARM_MS = 400;
/** How long a tooltip stays after the pointer leaves, so it can move onto the bubble. */
export const TOOLTIP_CLOSE_DELAY_MS = 120;

interface TooltipOwner {
	close(): void;
}

let showing: TooltipOwner | null = null;
let warm = false;
let coolTimer: ReturnType<typeof setTimeout> | undefined;

/** How long a tooltip that is asked to open now should wait. */
export function tooltipOpenDelay(): number {
	return showing || warm ? 0 : TOOLTIP_OPEN_DELAY_MS;
}

/** `owner` is now the one tooltip on screen; any other one closes. */
export function claimTooltip(owner: TooltipOwner): void {
	clearTimeout(coolTimer);
	warm = true;
	if (showing && showing !== owner) showing.close();
	showing = owner;
}

/** `owner` closed. The next tooltip opens without the delay for a moment. */
export function releaseTooltip(owner: TooltipOwner): void {
	if (showing !== owner) return;
	showing = null;
	clearTimeout(coolTimer);
	coolTimer = setTimeout(() => {
		warm = false;
	}, TOOLTIP_WARM_MS);
}
