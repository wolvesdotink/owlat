import { describe, expect, it } from 'vitest';
import { canFail, isClosedStatus, PROCESSING_LIFECYCLE, requiresManualTakeover } from '../reducers';
import type { ProcessingStatus } from '../types';

const STATUSES = [
	'received',
	'security_check',
	'quarantined',
	'classifying',
	'drafting',
	'draft_ready',
	'awaiting_clarification',
	'informational',
	'approved',
	'sent',
	'rejected',
	'archived',
	'failed',
] as const satisfies readonly ProcessingStatus[];

const EXPECTED_EDGES: Readonly<Record<ProcessingStatus, readonly ProcessingStatus[]>> = {
	received: ['security_check', 'archived', 'draft_ready'],
	security_check: ['classifying', 'quarantined', 'archived', 'draft_ready'],
	quarantined: ['received', 'archived'],
	classifying: ['drafting', 'draft_ready', 'awaiting_clarification', 'informational', 'archived'],
	informational: ['drafting', 'archived'],
	drafting: ['draft_ready', 'approved'],
	draft_ready: ['approved', 'rejected', 'archived'],
	awaiting_clarification: ['drafting', 'archived', 'draft_ready'],
	approved: ['sent', 'draft_ready'],
	sent: [],
	rejected: ['draft_ready'],
	archived: ['draft_ready'],
	failed: ['received', 'draft_ready'],
};

describe('inbox lifecycle edge conformance', () => {
	it('pins all thirteen core states and every declared legal edge', () => {
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

	it('keeps failure star-sourced only from open states', () => {
		for (const status of STATUSES) {
			expect(canFail(status), status).toBe(!isClosedStatus(status));
		}
		expect(STATUSES.filter((s) => PROCESSING_LIFECYCLE.isTerminal(s))).toEqual(['sent']);
		expect(STATUSES.filter((s) => isClosedStatus(s))).toEqual(['sent', 'rejected', 'archived']);
	});

	it('lets only a person move received, clarification, rejected and archived messages to draft_ready', () => {
		for (const from of STATUSES) {
			expect(requiresManualTakeover(from, 'draft_ready'), from).toBe(
				from === 'received' ||
					from === 'awaiting_clarification' ||
					from === 'rejected' ||
					from === 'archived'
			);
		}
		expect(requiresManualTakeover('received', 'security_check')).toBe(false);
	});
});
