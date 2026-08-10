/**
 * The requirement table's internal honesty.
 *
 * `CONTRIBUTION_CAPABILITY_REQUIREMENTS` states a bucket's dispatch class in two
 * places once a bucket carries more than one executable half: on the row, and on
 * each `moduleExports` entry. Two readers consume the two statements — the
 * published Contribution Reference splits its bucket tables by the ROW literal
 * (`apps/docs/__tests__/pluginDocs.test.ts` greps this file for it), while the
 * conformance reachability gate asserts real host consumers per MODULE EXPORT.
 * Nothing else makes them agree, so a row declared `'declared'` with a half
 * classed `'wired'` would put the bucket in the docs page's "not yet invoked"
 * table while the gate simultaneously demanded and found a production consumer,
 * with both suites green and the page wrong.
 *
 * This is that missing check: the row literal must equal the roll-up of its own
 * halves.
 */

import { describe, expect, it } from 'vitest';
import {
	bucketDispatch,
	CONTRIBUTION_CAPABILITY_REQUIREMENTS,
	PLUGIN_CONTRIBUTION_MODULE_EXPORTS,
	PLUGIN_DISPATCHED_CONTRIBUTION_KINDS,
	PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS,
} from '../contributionRequirements';

describe('contribution requirement table', () => {
	it('states one dispatch class per bucket, however many halves the bucket has', () => {
		for (const requirement of CONTRIBUTION_CAPABILITY_REQUIREMENTS) {
			expect(
				requirement.dispatch,
				`${requirement.bucket}: the row says '${requirement.dispatch}' but its moduleExports roll up to '${bucketDispatch(requirement.bucket)}' — the docs page reads the row and the reachability gate reads the halves`
			).toBe(bucketDispatch(requirement.bucket));
		}
	});

	it('calls a bucket dispatched only when EVERY half of it is', () => {
		// The bucket with two halves is the only place the rule is observable, and
		// it is in the dispatched set solely because both halves are wired — unwire
		// either and the summary must follow, which is what the first case pins.
		const halves = PLUGIN_CONTRIBUTION_MODULE_EXPORTS.filter(
			(moduleExport) => moduleExport.bucket === 'sendTransports'
		);
		expect(halves.length).toBeGreaterThan(1);
		expect(halves.every((half) => half.dispatch === 'wired')).toBe(true);
		expect(PLUGIN_DISPATCHED_CONTRIBUTION_KINDS).toContain('sendTransports');

		// Every declared bucket is declared because a half of it is, never because
		// a row said so on its own.
		for (const bucket of PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS) {
			expect(
				PLUGIN_CONTRIBUTION_MODULE_EXPORTS.some(
					(moduleExport) => moduleExport.bucket === bucket && moduleExport.dispatch === 'declared'
				),
				`${bucket} is summarised as not dispatched but every half of it is wired`
			).toBe(true);
		}
	});

	it('partitions every capability-enforced bucket exactly once', () => {
		const buckets = CONTRIBUTION_CAPABILITY_REQUIREMENTS.map((requirement) => requirement.bucket);
		expect(
			[...PLUGIN_DISPATCHED_CONTRIBUTION_KINDS, ...PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS].sort()
		).toEqual([...buckets].sort());
		expect(
			PLUGIN_DISPATCHED_CONTRIBUTION_KINDS.filter((bucket) =>
				PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS.includes(bucket)
			)
		).toEqual([]);
		expect(PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS.length).toBeGreaterThan(0);
	});
});
