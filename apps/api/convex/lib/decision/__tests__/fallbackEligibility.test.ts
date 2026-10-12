/**
 * D3 (ADR-0073, Sol r1 F4): only a clearly operational failure of a working
 * decision provider may hop to a paid language call. The adapters' own error
 * shapes are classified here, and a TypeSafe 404 over the real adapter makes
 * no language request.
 */

import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	generateObject: (args: unknown) => sdk.generateObject(args),
}));

import { mayFallBack, runDecision } from '../dispatch';
import { noul } from '../questions';
import { TypeSafeDecisionError } from '../../decisionProviders/typesafe';
import { LocalDecisionError } from '../../decisionProviders/local';
import { RedirectRefusedError, SsrfBlockedError } from '../../ssrfGuard';

const withCause = (code: string) =>
	new TypeSafeDecisionError('TypeSafe could not be reached (connection failure).', {
		retriable: true,
		cause: Object.assign(new Error('fetch failed'), {
			cause: Object.assign(new Error(code), { code }),
		}),
	});
const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

describe('mayFallBack', () => {
	it.each([
		['a 5xx', new TypeSafeDecisionError('down', { status: 503 })],
		['a 429', new TypeSafeDecisionError('busy', { status: 429 })],
		['a 408', new LocalDecisionError('slow', { status: 408 })],
		['a deadline', new TypeSafeDecisionError('late', { retriable: true, cause: timeout() })],
		['a reset connection', withCause('ECONNRESET')],
		['a timed-out connection', withCause('UND_ERR_CONNECT_TIMEOUT')],
	])('lets %s hop', (_label, error) => {
		expect(mayFallBack(error)).toBe(true);
	});

	it.each([
		['a 400', new TypeSafeDecisionError('malformed', { status: 400 })],
		['a 404', new TypeSafeDecisionError('no such endpoint', { status: 404 })],
		['a 401', new TypeSafeDecisionError('bad key', { status: 401 })],
		['a redirect status', new LocalDecisionError('moved', { status: 302, retriable: false })],
		[
			'a refused redirect',
			new TypeSafeDecisionError('redirect', {
				retriable: false,
				cause: new RedirectRefusedError('x'),
			}),
		],
		[
			'an SSRF refusal',
			new TypeSafeDecisionError('blocked', { retriable: false, cause: new SsrfBlockedError('x') }),
		],
		['an unresolvable host', withCause('ENOTFOUND')],
		['a refused connection', withCause('ECONNREFUSED')],
		[
			'a configuration error without a status',
			new Error('The local decision engine base URL is not valid.'),
		],
		['anything unrecognized', new Error('boom')],
	])('keeps %s terminal', (_label, error) => {
		expect(mayFallBack(error)).toBe(false);
	});
});

describe('a TypeSafe 404 through the real adapter', () => {
	it('makes no language request, even with the hop enabled', async () => {
		const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
		await expect(
			runDecision({
				feature: 'inbound_triage',
				state: 'Subject: hello',
				questions: { needsReply: noul('Does this need a reply?') },
				provider: { kind: 'typesafe', config: { apiKey: 'ts-key', fetchImpl } },
				fallbackTo: { kind: 'llm', config: {}, model: 'gpt-4.1-mini' },
				allowance: { allowed: true, fallbackAllowed: true },
				breaker: { isOpen: () => false, recordFailure: () => {} },
				recordUsage: () => {},
				admission: { admit: async () => null, extend: async () => {}, release: async () => {} },
				maxAttempts: 1,
			})
		).rejects.toThrow(/404/);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(sdk.generateObject).not.toHaveBeenCalled();
	});
});
