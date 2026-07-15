import { describe, expect, it } from 'vitest';
import {
	applyRestrictOnlyGateResult,
	createGateObjection,
	NO_GATE_OBJECTION,
	type GateDecision,
} from '../index';

const allowedDecision = (): GateDecision => ({ allowed: true, objections: [] });

describe('restrict-only gate results', () => {
	it('lets an explicit no-objection preserve an existing allowed decision', () => {
		expect(applyRestrictOnlyGateResult(allowedDecision(), NO_GATE_OBJECTION)).toEqual({
			allowed: true,
			objections: [],
		});
	});

	it('never lets a plugin widen an existing blocked decision', () => {
		const blocked: GateDecision = {
			allowed: false,
			objections: ['Core security scan failed'],
		};

		expect(applyRestrictOnlyGateResult(blocked, NO_GATE_OBJECTION)).toEqual(blocked);
	});

	it('adds a normalized objection and blocks the aggregate', () => {
		expect(
			applyRestrictOnlyGateResult(allowedDecision(), createGateObjection('  manager review  '))
		).toEqual({
			allowed: false,
			objections: ['manager review'],
		});
	});

	it.each([
		undefined,
		null,
		true,
		{ safe: true },
		{ outcome: 'approve' },
		{ outcome: 'objection' },
	])('fails closed for malformed result %#', (result) => {
		expect(applyRestrictOnlyGateResult(allowedDecision(), result)).toEqual({
			allowed: false,
			objections: ['Plugin gate returned an invalid result'],
		});
	});

	it('does not execute accessors while validating plugin gate output', () => {
		let reads = 0;
		const result = { outcome: 'objection' };
		Object.defineProperty(result, 'reason', {
			enumerable: true,
			get() {
				reads += 1;
				return 'approve';
			},
		});

		expect(applyRestrictOnlyGateResult(allowedDecision(), result)).toMatchObject({
			allowed: false,
		});
		expect(reads).toBe(0);
	});

	it('requires an honest objection reason', () => {
		expect(() => createGateObjection('   ')).toThrow('requires a reason');
	});
});
