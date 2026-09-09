import { describe, expect, it } from 'vitest';
import {
	transportOutcomeCounters,
	TRANSPORT_OUTCOME_EVENTS,
	ZERO_TRANSPORT_OUTCOME_TOTALS,
	type TransportOutcomeCounter,
} from '../transportOutcomeSummary';

describe('every counter column is reachable from the vocabulary', () => {
	it('leaves no column that only a reader ever touches', () => {
		const bumped = new Set<TransportOutcomeCounter>();
		for (const event of TRANSPORT_OUTCOME_EVENTS) {
			for (const isCalibration of [false, true]) {
				for (const counter of transportOutcomeCounters(event, isCalibration)) bumped.add(counter);
			}
		}
		const columns = Object.keys(ZERO_TRANSPORT_OUTCOME_TOTALS) as TransportOutcomeCounter[];
		expect(columns.filter((column) => !bumped.has(column))).toEqual([]);
	});
});
