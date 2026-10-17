/**
 * Where a fixed panel anchored to an element goes: under the anchor when it
 * fits, above it when it does not and there is more room there, and capped to
 * the room it gets (the panel scrolls inside) when it fits on neither side. If
 * even the larger side is a sliver (an anchor at the very edge of a short
 * window), the panel is laid over the anchor instead, kept inside the window.
 * Sideways it starts at the anchor's left edge and is kept inside the window.
 *
 * Pure so the flip and clamp are testable without layout; the caller measures
 * the panel's natural height (`scrollHeight`) and the anchor's rect.
 */
interface AnchorRect {
	top: number;
	bottom: number;
	left: number;
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
}

interface AnchoredPanelPlacement {
	side: 'below' | 'above' | 'overlay';
	style: { top?: string; bottom?: string; left: string; maxHeight: string };
}

export function placeAnchoredPanel(input: AnchoredPanelInput): AnchoredPanelPlacement {
	const { anchor, panelHeight, panelWidth, viewport } = input;
	const gap = input.gap ?? 6;
	const margin = input.margin ?? 8;
	const roomBelow = Math.max(0, viewport.height - anchor.bottom - gap - margin);
	const roomAbove = Math.max(0, anchor.top - gap - margin);
	const side = panelHeight > roomBelow && roomAbove > roomBelow ? 'above' : 'below';
	const room = side === 'above' ? roomAbove : roomBelow;
	const width = Math.min(panelWidth, viewport.width - 2 * margin);
	const left = `${Math.round(Math.min(Math.max(margin, anchor.left), viewport.width - width - margin))}px`;
	const fullRoom = Math.max(0, viewport.height - 2 * margin);
	if (room < Math.min(panelHeight, input.minRoom ?? 160)) {
		const height = Math.min(panelHeight, fullRoom);
		const top = Math.min(Math.max(margin, anchor.bottom + gap), viewport.height - height - margin);
		return {
			side: 'overlay',
			style: { top: `${Math.round(Math.max(margin, top))}px`, left, maxHeight: `${fullRoom}px` },
		};
	}
	const vertical =
		side === 'above'
			? { bottom: `${Math.round(viewport.height - anchor.top + gap)}px` }
			: { top: `${Math.round(anchor.bottom + gap)}px` };
	return {
		side,
		style: { ...vertical, left, maxHeight: `${Math.floor(room)}px` },
	};
}
