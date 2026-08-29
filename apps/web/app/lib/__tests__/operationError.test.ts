import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import { OPERATION_ERROR_CATEGORIES } from '@owlat/shared/operationError';
import {
	normalizeToOperationError,
	categoryTreatment,
	operationCopy,
	resolveOperationCopy,
	isTransportFailure,
	operationToastCopy,
	isSurfacedOperationError,
	SurfacedOperationError,
} from '../operationError';
import { createTestI18n } from '~/__tests__/i18n';

/** The real catalog, so the copy assertions stay assertions about English. */
const { t } = createTestI18n().global;
const copyFor = (op: Parameters<typeof operationCopy>[0]) =>
	resolveOperationCopy(operationCopy(op), (key) => t(key));

describe('normalizeToOperationError', () => {
	it('preserves the category, message, and data of a ConvexError Operation error', () => {
		const op = normalizeToOperationError(
			new ConvexError({
				category: 'invalid_input',
				message: 'Bad email',
				data: { field: 'email' },
			})
		);
		expect(op).toEqual({
			category: 'invalid_input',
			message: 'Bad email',
			data: { field: 'email' },
		});
	});

	it('preserves a categorized ConvexError without data', () => {
		const op = normalizeToOperationError(
			new ConvexError({ category: 'forbidden', message: 'No access' })
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
			false
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
	it('hands back the backend message as text, never as a key to translate', () => {
		// Backend messages carry names and addresses; running one through the
		// message compiler would read its punctuation as syntax.
		expect(operationCopy({ category: 'invalid_state', message: 'Template is published' })).toEqual({
			text: 'Template is published',
		});
		expect(copyFor({ category: 'invalid_state', message: 'Template is published' })).toBe(
			'Template is published'
		);
	});

	it('shows generic copy for internal (hides the raw message)', () => {
		expect(copyFor({ category: 'internal', message: 'TypeError: x is not a function' })).toBe(
			'Something went wrong. Please try again.'
		);
	});

	it('shows generic copy for network', () => {
		expect(copyFor({ category: 'network', message: 'Failed to fetch' })).toContain(
			'Connection problem'
		);
	});

	it('falls back to generic copy when the backend message is empty', () => {
		expect(copyFor({ category: 'forbidden', message: '' })).toBe(
			'Something went wrong. Please try again.'
		);
	});

	it('shows generic copy for an expired session', () => {
		expect(copyFor({ category: 'unauthenticated', message: 'No identity' })).toContain(
			'session has expired'
		);
	});
});

/**
 * The catch-block half of the seam. Three postbox call sites used to swallow a
 * throw into `console.error` and show the user nothing; these are the two rules
 * that make routing them through a toast safe — a surface-specific line only
 * where the policy has nothing better to say, and silence for a failure an
 * Operation module has already put on screen.
 */
describe('operationToastCopy', () => {
	const FALLBACK = 'components.postbox.postboxThreadReader.attachmentDownloadFailed';

	it('uses the surface fallback where the policy would say only "something went wrong"', () => {
		expect(operationToastCopy(new Error('boom'), FALLBACK)).toEqual({ key: FALLBACK });
	});

	it('keeps a transport failure as the connection line, not the fallback', () => {
		expect(operationToastCopy(new Error('Failed to fetch'), FALLBACK)).toEqual({
			key: 'shared.operationError.network',
		});
	});

	it('keeps a categorized backend refusal, which says more than any fallback', () => {
		expect(
			operationToastCopy(
				new ConvexError({ category: 'forbidden', message: 'This mailbox is not yours' }),
				FALLBACK
			)
		).toEqual({ text: 'This mailbox is not yours' });
	});

	it('still produces copy with no fallback offered', () => {
		expect(operationToastCopy(new Error('boom'))).toEqual({
			key: 'shared.operationError.generic',
		});
	});
});

describe('SurfacedOperationError', () => {
	it('marks a re-throw whose failure has already been shown', () => {
		expect(isSurfacedOperationError(new SurfacedOperationError('Send failed'))).toBe(true);
	});

	it('does not claim an ordinary throw', () => {
		expect(isSurfacedOperationError(new Error('Send failed'))).toBe(false);
		expect(isSurfacedOperationError('Send failed')).toBe(false);
		expect(isSurfacedOperationError(undefined)).toBe(false);
	});

	it('is an Error, so an unhandled one still reports a stack', () => {
		expect(new SurfacedOperationError('x')).toBeInstanceOf(Error);
	});
});
