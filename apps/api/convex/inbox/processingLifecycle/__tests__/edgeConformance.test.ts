import { describe, expect, it } from 'vitest';
import { canFail, PROCESSING_LIFECYCLE } from '../reducers';
import type { ProcessingStatus } from '../types';

const STATUSES = [
	'received',
	'security_check',
	'quarantined',
	'classifying',
	'drafting',
	'draft_ready',
	'awaiting_clarification',
	'approved',
	'sent',
	'rejected',
	'archived',
	'failed',
] as const satisfies readonly ProcessingStatus[];

const EXPECTED_EDGES: Readonly<Record<ProcessingStatus, readonly ProcessingStatus[]>> = {
	received: ['security_check', 'archived'],
	security_check: ['classifying', 'quarantined', 'archived'],
	quarantined: ['received', 'archived'],
	classifying: ['drafting', 'draft_ready', 'awaiting_clarification', 'archived'],
	drafting: ['draft_ready', 'approved'],
	draft_ready: ['approved', 'rejected', 'archived'],
	awaiting_clarification: ['drafting', 'archived'],
	approved: ['sent', 'draft_ready'],
	sent: [],
	rejected: [],
	archived: [],
	failed: ['received'],
};

describe('inbox lifecycle edge conformance', () => {
	it('pins all twelve core states and every declared legal edge', () => {
		expect(new Set(PROCESSING_LIFECYCLE.states)).toEqual(new Set(STATUSES));
		for (const from of STATUSES) {
			expect([...PROCESSING_LIFECYCLE.legalTargets(from)], from).toEqual(EXPECTED_EDGES[from]);
			for (const to of STATUSES) {
				expect(PROCESSING_LIFECYCLE.isLegalEdge(from, to), `${from}->${to}`).toBe(
					EXPECTED_EDGES[from].includes(to)
				);
			}
		}
	});

	it('keeps failure star-sourced only from non-terminal states', () => {
		for (const status of STATUSES) {
			expect(canFail(status), status).toBe(!PROCESSING_LIFECYCLE.isTerminal(status));
		}
		expect(STATUSES.filter((s) => PROCESSING_LIFECYCLE.isTerminal(s))).toEqual([
			'sent',
			'rejected',
			'archived',
		]);
	});
});
