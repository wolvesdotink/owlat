import { describe, expect, it } from 'vitest';
import { ConvexError } from 'convex/values';
import { extractOperationError } from '@owlat/shared/operationError';
import { InternalFailure, internalFailureOf } from '../errors';

/**
 * What the Convex runtime hands a caller when a nested `ctx.runMutation` throws
 * a `ConvexError`: a NEW `ConvexError` carrying only the data. The class of the
 * original is gone, so a classifier that relied on `instanceof` would miss it.
 */
function rebuiltByRuntime(error: ConvexError<never>): ConvexError<never> {
	const rebuilt = new ConvexError(error.message);
	(rebuilt as { data: unknown }).data = JSON.parse(JSON.stringify(error.data));
	return rebuilt as ConvexError<never>;
}

describe('InternalFailure', () => {
	it('carries its kind, retryability and attributes', () => {
		const failure = new InternalFailure('delivery.envelope_not_stored', {
			retryable: false,
			attrs: { attempt: 2 },
		});

		expect(failure).toBeInstanceOf(Error);
		expect(failure.name).toBe('InternalFailure');
		expect(failure.message).toBe('delivery.envelope_not_stored {"attempt":2}');
		expect(internalFailureOf(failure)).toEqual({
			kind: 'delivery.envelope_not_stored',
			retryable: false,
			attrs: { attempt: 2 },
		});
	});

	it('is read back after the runtime rebuilds it across a nested call', () => {
		const failure = new InternalFailure('delivery.send_identity_conflict', {
			retryable: false,
			attrs: { status: 409, provider: 'mta' },
		});

		expect(internalFailureOf(rebuiltByRuntime(failure as never))).toEqual({
			kind: 'delivery.send_identity_conflict',
			retryable: false,
			attrs: { status: 409, provider: 'mta' },
		});
	});

	it('reads as an internal Operation error with a fixed message to a client', () => {
		const failure = new InternalFailure('mta.dkim_ownership_conflict', { retryable: false });

		expect(extractOperationError(failure)).toMatchObject({
			category: 'internal',
			message: 'Internal error',
		});
	});

	it('keeps an explicit message local and out of the payload', () => {
		const failure = new InternalFailure('mta.dkim_ownership_conflict', {
			retryable: false,
			message: 'MTA DKIM registration failed (409): owner@example.com holds this key',
		});

		expect(failure.message).toContain('(409)');
		expect(JSON.stringify(failure.data)).not.toContain('owner@example.com');
		expect(JSON.stringify(failure.data)).not.toContain('(409)');
	});

	it('bounds the attributes: identifiers only, eight at most', () => {
		const failure = new InternalFailure('delivery.unhandled_worker_outcome', {
			retryable: true,
			attrs: {
				outcomeKind: 'mystery',
				recipient: 'person@example.com',
				detail: 'a sentence with spaces',
				'bad key': 'x',
				infinite: Number.POSITIVE_INFINITY,
				a: 1,
				b: 2,
				c: 3,
				d: 4,
				e: 5,
				f: 6,
			},
		});

		expect(failure.attrs).toEqual({
			outcomeKind: 'mystery',
			recipient: '<unsafe>',
			detail: '<unsafe>',
			a: 1,
			b: 2,
			c: 3,
			d: 4,
			e: 5,
		});
		expect(JSON.stringify(failure.data)).not.toContain('person@example.com');
	});
});

describe('internalFailureOf', () => {
	it('ignores plain errors, whatever they say', () => {
		expect(internalFailureOf(new Error('delivery.envelope_not_stored'))).toBeNull();
		expect(internalFailureOf('delivery.envelope_not_stored')).toBeNull();
		expect(internalFailureOf(null)).toBeNull();
	});

	it('ignores other Operation errors', () => {
		expect(
			internalFailureOf(new ConvexError({ category: 'internal', message: 'Internal error' }))
		).toBeNull();
		expect(
			internalFailureOf(new ConvexError({ category: 'already_exists', message: 'Taken' }))
		).toBeNull();
	});

	it('ignores a kind this build does not know', () => {
		const foreign = new ConvexError({
			category: 'internal',
			message: 'Internal error',
			data: { internalFailure: { kind: 'delivery.from_the_future', retryable: true, attrs: {} } },
		});

		expect(internalFailureOf(foreign)).toBeNull();
	});

	it('re-bounds attributes read off the wire', () => {
		const wire = new ConvexError({
			category: 'internal',
			message: 'Internal error',
			data: {
				internalFailure: {
					kind: 'delivery.envelope_not_stored',
					retryable: false,
					attrs: { to: 'person@example.com' },
				},
			},
		});

		expect(internalFailureOf(wire)?.attrs).toEqual({ to: '<unsafe>' });
	});
});
