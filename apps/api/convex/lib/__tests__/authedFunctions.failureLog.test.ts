/**
 * The builders' failure log: every public function built in `../authedFunctions`
 * logs a failed invocation exactly once as `function.<kind>.failed`, with the
 * Operation-error category and the org its floor resolved, and rethrows the
 * very value the handler threw. Composed builders (`featureGated`, the platform
 * gates) sit inside the base builder's boundary and must not log a second time.
 *
 * Handlers are driven through `_handler` with the floors mocked, as in
 * `authedFunctions.test.ts`; what is asserted is the console line the wrapper
 * writes (`lib/runtimeLog.ts#logEvent` prints one JSON object per event).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import {
	authedAction,
	authedMutation,
	authedQuery,
	featureGated,
	publicMutation,
	publicQuery,
} from '../authedFunctions';
import * as sessionOrganization from '../sessionOrganization';
import * as featureFlags from '../featureFlags';
import type { MutationSessionContext } from '../sessionOrganization';
import { QUERY_FAILURE_SAMPLE_RATE, shouldLogFailure } from '../functionLogging';
import { throwForbidden, throwInvalidInput, throwUnauthenticated } from '../../_utils/errors';

const MEMBER: MutationSessionContext = {
	userId: 'user-member',
	role: 'editor',
	activeOrganizationId: 'org-1',
};

vi.mock('../sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof sessionOrganization>();
	return {
		...actual,
		requireOrgMember: vi.fn(async () => MEMBER),
		getMutationContext: vi.fn(async () => MEMBER),
	};
});

vi.mock('../featureFlags', async (importOriginal) => {
	const actual = await importOriginal<typeof featureFlags>();
	return { ...actual, assertFeatureEnabled: vi.fn(async () => undefined) };
});

const ctx = {
	db: {},
	runQuery: vi.fn(async () => ({ organizationId: 'org-action' })),
} as unknown as QueryCtx & MutationCtx;

type LooseBuilder = (config: {
	args: Record<string, never>;
	handler: (c: never, a: never, s: never) => unknown;
}) => unknown;

function build(builder: unknown, handler: () => unknown): unknown {
	return (builder as LooseBuilder)({
		args: {},
		handler: handler as unknown as (c: never, a: never, s: never) => unknown,
	});
}

async function invoke(registered: unknown): Promise<unknown> {
	const inner = registered as { _handler: (c: unknown, a: unknown) => Promise<unknown> };
	return inner._handler(ctx, {});
}

/** Every `function.*` event the console received, parsed. */
function failureEvents(): Array<Record<string, unknown>> {
	const lines = [consoleSpies.warn, consoleSpies.error, consoleSpies.info, consoleSpies.debug]
		.flatMap((spy) => spy.mock.calls)
		.map((call) => call[0])
		.filter((line): line is string => typeof line === 'string' && line.startsWith('{'));
	return lines
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((record) => String(record['event']).startsWith('function.'));
}

let consoleSpies: Record<'warn' | 'error' | 'info' | 'debug', ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
	vi.clearAllMocks();
	consoleSpies = {
		warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
		error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
		info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
		debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('a failed public mutation', () => {
	it('logs one event for a synchronous throw and rethrows the same value', async () => {
		const thrown = new Error('boom');
		const fn = build(authedMutation, () => {
			throw thrown;
		});

		await expect(invoke(fn)).rejects.toBe(thrown);

		expect(failureEvents()).toEqual([
			{
				event: 'function.mutation.failed',
				level: 'error',
				orgId: 'org-1',
				outcome: 'failed',
				category: 'internal',
			},
		]);
		expect(consoleSpies.error).toHaveBeenCalledTimes(1);
	});

	it('logs one event for an asynchronous rejection, with the Operation category', async () => {
		let thrown: unknown;
		const fn = build(authedMutation, async () => {
			try {
				throwInvalidInput('bad');
			} catch (error) {
				thrown = error;
				throw error;
			}
		});

		const rejection = await invoke(fn).catch((error: unknown) => error);
		expect(thrown).toBeDefined();
		expect(rejection).toBe(thrown);

		const events = failureEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: 'function.mutation.failed',
			level: 'warn',
			orgId: 'org-1',
			category: 'invalid_input',
		});
	});

	it('carries no org when the auth floor itself refuses', async () => {
		vi.mocked(sessionOrganization.getMutationContext).mockImplementationOnce(async () =>
			throwUnauthenticated()
		);
		const handler = vi.fn();
		const fn = build(authedMutation, handler);

		await expect(invoke(fn)).rejects.toMatchObject({ data: { category: 'unauthenticated' } });

		expect(handler).not.toHaveBeenCalled();
		const events = failureEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).not.toHaveProperty('orgId');
		expect(events[0]).toMatchObject({ category: 'unauthenticated' });
	});

	it('never logs the error message or payload', async () => {
		const fn = build(authedMutation, () =>
			throwForbidden('person@example.com may not', { subject: 'Quarterly numbers' })
		);

		await expect(invoke(fn)).rejects.toBeDefined();

		const line = JSON.stringify(failureEvents());
		expect(line).not.toContain('person@example.com');
		expect(line).not.toContain('Quarterly numbers');
	});

	it('reads no clock for a query or mutation', async () => {
		const clock = vi.spyOn(Date, 'now');
		const fn = build(authedQuery, () => {
			throw new Error('bug');
		});

		await expect(invoke(fn)).rejects.toThrow('bug');

		expect(clock).not.toHaveBeenCalled();
		expect(failureEvents()[0]).not.toHaveProperty('durationMs');
	});

	it('logs nothing when the handler succeeds', async () => {
		const fn = build(authedMutation, async () => 'ok');

		await expect(invoke(fn)).resolves.toBe('ok');

		expect(failureEvents()).toEqual([]);
	});

	it('logs a public mutation without an org', async () => {
		const fn = build(publicMutation, () => {
			throw new Error('boom');
		});

		await expect(invoke(fn)).rejects.toThrow('boom');

		const events = failureEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).not.toHaveProperty('orgId');
	});
});

describe('composed builders', () => {
	it('log a failure in the feature-flag floor once, through the base builder', async () => {
		vi.mocked(featureFlags.assertFeatureEnabled).mockImplementationOnce(async () =>
			throwForbidden('Feature disabled')
		);
		const fn = build(featureGated(authedMutation, 'chat'), vi.fn());

		await expect(invoke(fn)).rejects.toMatchObject({ data: { category: 'forbidden' } });

		const events = failureEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: 'function.mutation.failed',
			orgId: 'org-1',
			category: 'forbidden',
		});
	});
});

describe('a failed authed action', () => {
	it('is attributed to the org the membership floor resolved', async () => {
		const fn = build(authedAction, async () => {
			throw new Error('provider down');
		});

		await expect(invoke(fn)).rejects.toThrow('provider down');

		expect(failureEvents()).toEqual([
			expect.objectContaining({
				event: 'function.action.failed',
				orgId: 'org-action',
				category: 'internal',
				// Only an action's clock moves, so only an action reports a duration.
				durationMs: expect.any(Number),
			}),
		]);
	});
});

describe('query failures are sampled', () => {
	it('logs an expected query failure only when the draw falls under the rate', async () => {
		const fn = build(authedQuery, () => throwForbidden('no'));
		const random = vi.spyOn(Math, 'random');

		random.mockReturnValueOnce(QUERY_FAILURE_SAMPLE_RATE + 0.01);
		await expect(invoke(fn)).rejects.toBeDefined();
		expect(failureEvents()).toEqual([]);

		random.mockReturnValueOnce(QUERY_FAILURE_SAMPLE_RATE / 2);
		await expect(invoke(fn)).rejects.toBeDefined();
		expect(failureEvents()).toEqual([
			expect.objectContaining({
				event: 'function.query.failed',
				orgId: 'org-1',
				category: 'forbidden',
				detail: { sampleRate: QUERY_FAILURE_SAMPLE_RATE },
			}),
		]);
	});

	it('always logs an internal query failure', async () => {
		const fn = build(publicQuery, () => {
			throw new Error('bug');
		});
		vi.spyOn(Math, 'random').mockReturnValue(0.99);

		await expect(invoke(fn)).rejects.toThrow('bug');

		expect(failureEvents()).toEqual([
			expect.objectContaining({ event: 'function.query.failed', category: 'internal' }),
		]);
	});

	it('states the sampling rule as a pure function', () => {
		expect(shouldLogFailure('mutation', 'forbidden', 0.99)).toBe(true);
		expect(shouldLogFailure('action', 'not_found', 0.99)).toBe(true);
		expect(shouldLogFailure('query', 'internal', 0.99)).toBe(true);
		expect(shouldLogFailure('query', 'forbidden', 0.99)).toBe(false);
		expect(shouldLogFailure('query', 'forbidden', 0)).toBe(true);
	});
});
