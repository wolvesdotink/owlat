import { describe, expect, it } from 'vitest';
import { canFail, LEGAL_EDGES, TERMINAL } from '../reducers';
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
		expect(new Set(Object.keys(LEGAL_EDGES))).toEqual(new Set(STATUSES));
		for (const from of STATUSES) {
			expect([...LEGAL_EDGES[from]], from).toEqual(EXPECTED_EDGES[from]);
			for (const to of STATUSES) {
				expect(LEGAL_EDGES[from].has(to), `${from}->${to}`).toBe(EXPECTED_EDGES[from].includes(to));
			}
		}
	});

	it('keeps failure star-sourced only from non-terminal states', () => {
		for (const status of STATUSES) expect(canFail(status), status).toBe(!TERMINAL.has(status));
		expect([...TERMINAL]).toEqual(['sent', 'rejected', 'archived']);
	});
});
