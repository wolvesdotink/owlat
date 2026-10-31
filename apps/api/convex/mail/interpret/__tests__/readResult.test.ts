/**
 * A stored extraction is read back through the validator it was written
 * under: a payload that parses but is not a result is no result, so a replay
 * never projects needs-reply facts out of it.
 */

import { describe, expect, it } from 'vitest';
import type { Doc } from '../../../_generated/dataModel';
import { readResult } from '../load';
import { reduceResult } from './interpret.testlib';

const rowWith = (payload: string | undefined) =>
	({ payload }) as unknown as Doc<'messageInterpretations'>;

describe('readResult', () => {
	it('reads a stored result back, keeping a field a newer release added', async () => {
		const stored = { ...reduceResult(), addedLater: true };
		expect(await readResult(rowWith(JSON.stringify(stored)))).toEqual(stored);
	});

	it.each([
		['an urgency outside the union', { ...reduceResult(), urgency: 'urgent' }],
		['items that are not a list', { ...reduceResult(), items: {} }],
		['a dropped count that is not a number', { ...reduceResult(), dropped: { grounding: '1' } }],
		['a JSON scalar', 42],
	])('is null for a payload with %s', async (_label, payload) => {
		expect(await readResult(rowWith(JSON.stringify(payload)))).toBeNull();
	});

	it('is null for a payload that is not JSON, or no payload at all', async () => {
		expect(await readResult(rowWith('{"items":'))).toBeNull();
		expect(await readResult(rowWith(undefined))).toBeNull();
	});
});
