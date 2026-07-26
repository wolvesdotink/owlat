/**
 * Deliverability cell key — the single coordinate every measurement, outcome
 * bucket and ramp decision is keyed by.
 *
 * A cell is `(stream, destinationProvider)`:
 *   - `stream` is the traffic class (`campaign` | `automation` | `transactional`),
 *     matching the shipped `providerRoutes.messageType` union exactly so the
 *     new axis is a pure widening of what routing already knows.
 *   - `destinationProvider` is the SHIPPED, MX-learned classification from
 *     `deliverabilityRouting.ts` (`DESTINATION_PROVIDER_KEYS`). No second
 *     domain map exists, and none should be introduced.
 *
 * The string form is `${stream}:${destinationProvider}` (e.g. `campaign:gmail`).
 * This module is the ONE implementation of that format — every later consumer
 * (outcome buckets, the ramp controller, the dashboard) formats and parses
 * through here rather than concatenating strings inline.
 */

import { DESTINATION_PROVIDER_KEYS, type DestinationProviderKey } from './deliverabilityRouting';

/** Traffic classes, mirroring `providerRoutes.messageType`. */
export const DELIVERABILITY_STREAM_KEYS = ['campaign', 'automation', 'transactional'] as const;

export type DeliverabilityStream = (typeof DELIVERABILITY_STREAM_KEYS)[number];

/** Structured cell coordinate. */
export interface DeliverabilityCell {
	readonly stream: DeliverabilityStream;
	readonly destinationProvider: DestinationProviderKey;
}

/**
 * The canonical string form. A template-literal type, so an invalid key is a
 * compile error wherever the key is built from known parts.
 */
export type DeliverabilityCellKey = `${DeliverabilityStream}:${DestinationProviderKey}`;

const CELL_KEY_SEPARATOR = ':';

export function isDeliverabilityStream(value: unknown): value is DeliverabilityStream {
	return (
		typeof value === 'string' && (DELIVERABILITY_STREAM_KEYS as readonly string[]).includes(value)
	);
}

function isDestinationProvider(value: unknown): value is DestinationProviderKey {
	return (
		typeof value === 'string' && (DESTINATION_PROVIDER_KEYS as readonly string[]).includes(value)
	);
}

/** Format a cell coordinate into its canonical `stream:provider` key. */
export function formatCellKey(cell: DeliverabilityCell): DeliverabilityCellKey {
	return `${cell.stream}${CELL_KEY_SEPARATOR}${cell.destinationProvider}`;
}

/**
 * Parse a canonical cell key. Returns `null` for anything that is not exactly
 * one known stream, one separator and one known destination provider — no
 * trimming, no case folding, no partial acceptance. Callers that receive a key
 * from storage treat `null` as "unclassifiable row", never as a throw.
 */
export function parseCellKey(value: unknown): DeliverabilityCell | null {
	if (typeof value !== 'string') return null;
	const parts = value.split(CELL_KEY_SEPARATOR);
	if (parts.length !== 2) return null;
	const [stream, destinationProvider] = parts;
	if (!isDeliverabilityStream(stream) || !isDestinationProvider(destinationProvider)) return null;
	return { stream, destinationProvider };
}

export function isDeliverabilityCellKey(value: unknown): value is DeliverabilityCellKey {
	return parseCellKey(value) !== null;
}

/** Every cell, in a stable order. Useful for dashboards and exhaustive tests. */
export function allDeliverabilityCells(): DeliverabilityCell[] {
	const cells: DeliverabilityCell[] = [];
	for (const stream of DELIVERABILITY_STREAM_KEYS) {
		for (const destinationProvider of DESTINATION_PROVIDER_KEYS) {
			cells.push({ stream, destinationProvider });
		}
	}
	return cells;
}
