/**
 * Where a fixed panel anchored to an element goes: under the anchor when it
 * fits, above it when it does not and there is more room there, and capped to
 * the room it gets (the panel scrolls inside) when it fits on neither side. If
 * even the larger side is a sliver (an anchor at the very edge of a short
 * window), the panel is laid over the anchor instead, kept inside the window.
 * Sideways it starts at the anchor's left edge (or, with `align: 'end'`, ends at
 * its right edge) and is kept inside the window. An anchor partly or wholly
 * outside the window is clamped into it first, so every bound this returns lies
 * inside the window; whether to keep a panel whose anchor has left the window
 * is the caller's call (`isAnchorInView`).
 *
 * Every coordinate is a viewport (client) coordinate, as a `position: fixed`
 * panel needs: pass `getBoundingClientRect()` as is, never add the window's
 * scroll offset.
 *
 * Pure so the flip and clamp are testable without layout; the caller measures
 * the panel's natural height (`scrollHeight`) and the anchor's rect.
 */
interface AnchorRect {
	top: number;
	bottom: number;
	left: number;
	right?: number;
}

/** Whether any of the anchor is inside the window. */
export function isAnchorInView(
	anchor: AnchorRect,
	viewport: { width: number; height: number }
): boolean {
	const right = anchor.right ?? anchor.left;
	return (
		anchor.bottom > 0 && anchor.top < viewport.height && right >= 0 && anchor.left < viewport.width
	);
}

interface AnchoredPanelInput {
	anchor: AnchorRect;
	/** The panel's natural (unclamped) height; 0 before it has rendered. */
	panelHeight: number;
	panelWidth: number;
	viewport: { width: number; height: number };
	gap?: number;
	margin?: number;
	/** Below this much room on the chosen side the panel overlays the anchor. */
	minRoom?: number;
	/** Line the panel's left edge up with the anchor's (`start`) or its right edge (`end`). */
	align?: 'start' | 'end';
}

interface AnchoredPanelPlacement {
	side: 'below' | 'above' | 'overlay';
	style: { top?: string; bottom?: string; left: string; maxHeight: string };
}

export function placeAnchoredPanel(input: AnchoredPanelInput): AnchoredPanelPlacement {
	const { panelHeight, panelWidth, viewport } = input;
	const clampY = (y: number) => Math.min(Math.max(y, 0), viewport.height);
	const anchor = {
		top: clampY(input.anchor.top),
		bottom: clampY(input.anchor.bottom),
		left: input.anchor.left,
	};
	const gap = input.gap ?? 6;
	const margin = input.margin ?? 8;
	// The panel's edge on each side, kept a margin inside the window, and the
	// room left between that edge and the far side of the window.
	const edge = (y: number) => Math.min(Math.max(margin, y), viewport.height - margin);
	const belowTop = edge(anchor.bottom + gap);
	const aboveBottom = edge(viewport.height - anchor.top + gap);
	const roomBelow = Math.max(0, viewport.height - belowTop - margin);
	const roomAbove = Math.max(0, viewport.height - aboveBottom - margin);
	const side = panelHeight > roomBelow && roomAbove > roomBelow ? 'above' : 'below';
	const room = side === 'above' ? roomAbove : roomBelow;
	const width = Math.min(panelWidth, viewport.width - 2 * margin);
	const start =
		input.align === 'end' ? (input.anchor.right ?? anchor.left + width) - width : anchor.left;
	const left = `${Math.round(Math.min(Math.max(margin, start), viewport.width - width - margin))}px`;
	const fullRoom = Math.max(0, viewport.height - 2 * margin);
	if (room < Math.min(panelHeight, input.minRoom ?? 160)) {
		const height = Math.min(panelHeight, fullRoom);
		const top = Math.min(belowTop, viewport.height - height - margin);
		return {
			side: 'overlay',
			style: { top: `${Math.round(Math.max(margin, top))}px`, left, maxHeight: `${fullRoom}px` },
		};
	}
	const vertical =
		side === 'above'
			? { bottom: `${Math.round(aboveBottom)}px` }
			: { top: `${Math.round(belowTop)}px` };
	return {
		side,
		style: { ...vertical, left, maxHeight: `${Math.floor(room)}px` },
	};
}
