/**
 * `conditionsLookupReadsPerContact` — the per-contact DOCUMENT cost of the
 * bounded condition preload.
 *
 * The binding capacity pre-flight (P0-5) budgets its audience scan in documents
 * because Convex caps a function execution at 16,384 of them. A row is NOT one
 * document: a segment carrying two `topic_membership` conditions point-reads
 * two extra documents per contact. Getting this multiplier wrong is how a
 * "bounded" scan silently overruns the limit, the fail-open catch swallows the
 * throw, and the gate goes dark on exactly the audiences it exists for — so the
 * number is pinned here, per kind.
 */

import { describe, it, expect } from 'vitest';
import { conditionsLookupReadsPerContact } from '..';
import type { Condition } from '../types';

const topic = (topicId: string): Condition => ({
	kind: 'topic_membership',
	topicId,
	operator: 'equals',
});

const property = (field: string): Condition => ({
	kind: 'contact_property',
	field,
	operator: 'equals',
	value: 'x',
});

const activity = (): Condition => ({
	kind: 'email_activity',
	field: 'opened',
	operator: 'is_true',
});

describe('conditionsLookupReadsPerContact', () => {
	it('is zero with no conditions', () => {
		expect(conditionsLookupReadsPerContact([])).toBe(0);
	});

	it('charges nothing for kinds denormalized onto the contact row', () => {
		// `email_activity` reads `hasOpened` / `hasClicked` off the contact itself,
		// and built-in property fields are columns on that same row.
		expect(conditionsLookupReadsPerContact([activity(), property('email')])).toBe(0);
	});

	it('charges one read per DISTINCT topic, not per condition', () => {
		expect(conditionsLookupReadsPerContact([topic('t1')])).toBe(1);
		expect(conditionsLookupReadsPerContact([topic('t1'), topic('t2')])).toBe(2);
		expect(conditionsLookupReadsPerContact([topic('t1'), topic('t1')])).toBe(1);
	});

	it('charges one read per DISTINCT custom property', () => {
		expect(conditionsLookupReadsPerContact([property('plan')])).toBe(1);
		expect(conditionsLookupReadsPerContact([property('plan'), property('plan')])).toBe(1);
		expect(conditionsLookupReadsPerContact([property('plan'), property('tier')])).toBe(2);
	});

	it('sums across kinds — the multiplier the document budget is charged with', () => {
		expect(
			conditionsLookupReadsPerContact([topic('t1'), topic('t2'), property('plan'), activity()])
		).toBe(3);
	});
});
