import { describe, expect, it } from 'vitest';
import { extractOperationError } from '@owlat/shared/operationError';
import { paginateClientCursor } from '../pagination';

const failingWith = (error: Error) => ({
	paginate: async (): Promise<never> => {
		throw error;
	},
});

async function thrown(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a throw');
}

describe('paginateClientCursor', () => {
	it.each([
		['the deployed refusal of a cursor that does not decode', new Error('Failed to parse cursor')],
		[
			'the deployed refusal of a cursor from another query',
			new Error('InvalidCursor: Tried to run a query starting from a cursor'),
		],
		[
			'the test backend cursor decode failure',
			new Error('Unexpected token \'o\', "not-a-cursor" is not valid JSON'),
		],
	])('answers %s as invalid_input naming cursor', async (_label, error) => {
		const refusal = await thrown(
			paginateClientCursor(failingWith(error), { numItems: 10, cursor: 'c' })
		);
		expect(extractOperationError(refusal)).toMatchObject({
			category: 'invalid_input',
			message: 'Invalid cursor',
			data: { field: 'cursor' },
		});
	});

	it('passes on any other throw with a cursor, so a backend fault stays a 5xx', async () => {
		const fault = new Error('Transient error while reading');
		const error = await thrown(
			paginateClientCursor(failingWith(fault), { numItems: 10, cursor: 'c' })
		);
		expect(error).toBe(fault);
	});

	it('passes on a throw without a cursor', async () => {
		const fault = new Error('InvalidCursor: Failed to parse cursor');
		const error = await thrown(
			paginateClientCursor(failingWith(fault), { numItems: 10, cursor: null })
		);
		expect(error).toBe(fault);
	});
});
