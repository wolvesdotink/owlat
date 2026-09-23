/**
 * When the Delivery → Advanced screens have nothing to show yet.
 *
 * The four screens (Controls, Cells, Measurement, Independence) describe a ramp:
 * a relay and your own server sharing traffic, cell by cell. On an instance
 * where that has not started they used to render their full furniture over no
 * data — a table header with no rows, fifteen quiet cards — with nothing saying
 * what fills them or where to start. These predicates decide when a screen
 * shows one explanatory empty state instead; the copy lives with the screens.
 *
 * Pure: the screens pass in what their queries answered.
 */
import type { IndependenceDayPoint } from '@owlat/shared/deliverabilityIndependence';

/** Where every one of those empty states points: the guided way in. */
export const DELIVERY_MIGRATE_ROUTE = '/dashboard/admin/delivery/migrate';

/**
 * The ramp has not taken over any cell. The grid is fifteen rows of "not
 * managed" then, which answers none of its four questions.
 */
export function isRampInactive(cells: readonly { isRampManaged: boolean }[]): boolean {
	return !cells.some((cell) => cell.isRampManaged);
}

/**
 * No cell carried any mail in the reported window, on either arm. Every card
 * would be an empty chart; one sentence says the same thing better.
 */
export function hasNoMeasuredTraffic(
	cells: readonly { own: { sent: number }; reference: { sent: number } | null }[]
): boolean {
	return cells.every((cell) => cell.own.sent === 0 && (cell.reference?.sent ?? 0) === 0);
}

/**
 * Nothing was sent in the independence window. The headline card still has a
 * fact to show (today's warm-up capacity, or the share once there is one); the
 * chart and the projection below it do not.
 */
export function hasNoIndependenceTraffic(series: readonly IndependenceDayPoint[]): boolean {
	return series.every(
		(point) =>
			!(Number.isFinite(point.own) && point.own > 0) &&
			!(Number.isFinite(point.reference) && point.reference > 0)
	);
}
