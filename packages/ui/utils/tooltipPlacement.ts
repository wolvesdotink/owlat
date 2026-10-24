/**
 * Where a tooltip goes relative to its trigger: centred over it on the
 * preferred side, flipped to the other side when it does not fit there and
 * there is more room on the other, and kept a margin inside the window
 * sideways and (when it fits on neither side) vertically.
 *
 * Every coordinate is a viewport (client) coordinate for a `position: fixed`
 * bubble: pass `getBoundingClientRect()` as is. Pure so the flip and the clamp
 * are testable without layout.
 */
interface TooltipPlacementInput {
	anchor: { top: number; bottom: number; left: number; right: number };
	/** The bubble's rendered size. */
	width: number;
	height: number;
	viewport: { width: number; height: number };
	side?: 'top' | 'bottom';
	gap?: number;
	margin?: number;
}

interface TooltipPlacement {
	side: 'top' | 'bottom';
	top: number;
	left: number;
}

export function placeTooltip(input: TooltipPlacementInput): TooltipPlacement {
	const { anchor, width, height, viewport } = input;
	const gap = input.gap ?? 6;
	const margin = input.margin ?? 8;
	const roomAbove = anchor.top - gap - margin;
	const roomBelow = viewport.height - anchor.bottom - gap - margin;
	const preferred = input.side ?? 'top';
	const preferredRoom = preferred === 'top' ? roomAbove : roomBelow;
	const otherRoom = preferred === 'top' ? roomBelow : roomAbove;
	const side =
		height > preferredRoom && otherRoom > preferredRoom
			? preferred === 'top'
				? 'bottom'
				: 'top'
			: preferred;
	const rawTop = side === 'top' ? anchor.top - gap - height : anchor.bottom + gap;
	const top = clamp(rawTop, margin, viewport.height - height - margin);
	const centre = (anchor.left + anchor.right) / 2;
	const left = clamp(centre - width / 2, margin, viewport.width - width - margin);
	return { side, top: Math.round(top), left: Math.round(left) };
}

/** `value` kept within [min, max]; `min` wins when the range is empty (a bubble wider than the window). */
function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
