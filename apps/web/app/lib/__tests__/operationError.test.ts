import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import { OPERATION_ERROR_CATEGORIES } from '@owlat/shared/operationError';
import {
	normalizeToOperationError,
	categoryTreatment,
	operationCopy,
	isTransportFailure,
} from '../operationError';

describe('normalizeToOperationError', () => {
	it('preserves the category, message, and data of a ConvexError Operation error', () => {
		const op = normalizeToOperationError(
			new ConvexError({
				category: 'invalid_input',
				message: 'Bad email',
				data: { field: 'email' },
			}),
		);
		expect(op).toEqual({
			category: 'invalid_input',
			message: 'Bad email',
			data: { field: 'email' },
		});
	});

	it('preserves a categorized ConvexError without data', () => {
		const op = normalizeToOperationError(
			new ConvexError({ category: 'forbidden', message: 'No access' }),
		);
		expect(op.category).toBe('forbidden');
		expect(op.message).toBe('No access');
	});

	it('collapses a plain (non-Operation) Error to internal', () => {
		const op = normalizeToOperationError(new Error('boom'));
		expect(op.category).toBe('internal');
		expect(op.message).toBe('boom');
	});

	it('collapses a ConvexError with a non-Operation payload to internal', () => {
		const op = normalizeToOperationError(new ConvexError({ foo: 'bar' }));
		expect(op.category).toBe('internal');
	});

	it('maps a transport failure (failed fetch) to network', () => {
		const op = normalizeToOperationError(new TypeError('Failed to fetch'));
		expect(op.category).toBe('network');
	});

	it('maps a dropped websocket to network', () => {
		const op = normalizeToOperationError(new Error('WebSocket connection closed'));
		expect(op.category).toBe('network');
	});

	it('maps a subscription timeout to network', () => {
		const op = normalizeToOperationError(new Error('Convex query subscription timed out'));
		expect(op.category).toBe('network');
	});
});

describe('isTransportFailure', () => {
	it('is false for a categorized backend error', () => {
		expect(isTransportFailure(new ConvexError({ category: 'not_found', message: 'x' }))).toBe(
			false,
		);
	});

	it('is false for an ordinary runtime error', () => {
		expect(isTransportFailure(new Error('cannot read property of undefined'))).toBe(false);
	});
});

describe('categoryTreatment', () => {
	it('routes each category to the right surface', () => {
		expect(categoryTreatment('unauthenticated').surface).toBe('redirect');
		expect(categoryTreatment('forbidden').surface).toBe('toast');
		expect(categoryTreatment('not_found').surface).toBe('toast');
		expect(categoryTreatment('invalid_input').surface).toBe('inline');
		expect(categoryTreatment('already_exists').surface).toBe('inline');
		expect(categoryTreatment('conflict').surface).toBe('toast');
		expect(categoryTreatment('invalid_state').surface).toBe('toast');
		expect(categoryTreatment('rate_limited').surface).toBe('toast');
		expect(categoryTreatment('limit_reached').surface).toBe('toast');
		expect(categoryTreatment('internal').surface).toBe('toast');
		expect(categoryTreatment('network').surface).toBe('toast');
	});

	it('reports to telemetry only for internal and network', () => {
		for (const category of OPERATION_ERROR_CATEGORIES) {
			const shouldReport = category === 'internal' || category === 'network';
			expect(categoryTreatment(category).report).toBe(shouldReport);
		}
	});
});

describe('operationCopy', () => {
	it('shows the backend message for categories with user-facing detail', () => {
		expect(operationCopy({ category: 'invalid_state', message: 'Template is published' })).toBe(
			'Template is published',
		);
	});

	it('shows generic copy for internal (hides the raw message)', () => {
		expect(operationCopy({ category: 'internal', message: 'TypeError: x is not a function' })).toBe(
			'Something went wrong. Please try again.',
		);
	});

	it('shows generic copy for network', () => {
		expect(operationCopy({ category: 'network', message: 'Failed to fetch' })).toContain(
			'Connection problem',
		);
	});

	it('falls back to generic copy when the backend message is empty', () => {
		expect(operationCopy({ category: 'forbidden', message: '' })).toBe(
			'Something went wrong. Please try again.',
		);
	});
});
