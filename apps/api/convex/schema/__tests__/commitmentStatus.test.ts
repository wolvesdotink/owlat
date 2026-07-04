/**
 * `isCommitmentOpen` semantics (schema/knowledge.ts).
 *
 * Locks the rule the open-commitments recall depends on: a commitment with no
 * explicit status is treated as OPEN (durable commitments authored before the
 * field, and fresh extractions that don't set it, stay recallable until a human
 * resolves them). Only `fulfilled` / `cancelled` drop out.
 */

import { describe, it, expect } from 'vitest';
import { isCommitmentOpen } from '../knowledge';

describe('isCommitmentOpen', () => {
	it('treats undefined status as open (durable until explicitly resolved)', () => {
		expect(isCommitmentOpen(undefined)).toBe(true);
	});

	it('treats explicit open as open', () => {
		expect(isCommitmentOpen('open')).toBe(true);
	});

	it('treats fulfilled and cancelled as not open', () => {
		expect(isCommitmentOpen('fulfilled')).toBe(false);
		expect(isCommitmentOpen('cancelled')).toBe(false);
	});
});
