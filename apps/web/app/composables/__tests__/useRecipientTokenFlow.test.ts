import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { withSetup } from '~/__tests__/withSetup';
import { PUBLIC_TOKEN_REASONS, type PublicTokenResult } from '~/lib/publicTokenClient';
import {
	useRecipientTokenFlow,
	type RecipientTokenAction,
	type RecipientTokenFlowOptions,
} from '../useRecipientTokenFlow';

let query: Record<string, unknown>;

beforeEach(() => {
	query = { token: 'tok' };
	vi.stubGlobal('useRoute', () => ({ query }));
	window.sessionStorage.clear();
	window.history.replaceState(null, '', '/unsubscribe');
});

type Keys = Omit<RecipientTokenFlowOptions<unknown>, 'verify'>;

const KEYS: Keys = {
	missingTokenKey: 'page.errors.missingToken',
	fallbackKey: 'page.errors.invalid',
	unreachableKey: 'page.errors.verifyFailed',
	reasons: { expired: 'page.errors.expired' },
};

function setup<V>(verify: RecipientTokenAction<V>, overrides: Partial<Keys> = {}) {
	const keys: Keys = { ...KEYS, ...overrides } as Keys;
	return withSetup(() => useRecipientTokenFlow({ ...keys, verify })).result;
}

const ok = <T>(data: T): PublicTokenResult<T> => ({ ok: true, data });
const fail = (reason: string): PublicTokenResult<never> => ({ ok: false, reason });

describe('useRecipientTokenFlow — verify on mount', () => {
	it('verifies the token and exposes the data as ready', async () => {
		const verify = vi.fn(async () => ok({ email: 'ada@example.com' }));
		const flow = setup(verify);
		expect(flow.state.value).toBe('loading');

		await flushPromises();

		expect(verify).toHaveBeenCalledWith('tok');
		expect(flow.state.value).toBe('ready');
		expect(flow.data.value).toEqual({ email: 'ada@example.com' });
		expect(flow.errorKey.value).toBeNull();
	});

	it.each([[{}], [{ token: '' }], [{ token: ['a', 'b'] }]])(
		'lands on the missing-token key without a request when the query is %j',
		async (q) => {
			query = q;
			const verify = vi.fn(async () => ok({}));
			const flow = setup(verify);
			await flushPromises();

			expect(verify).not.toHaveBeenCalled();
			expect(flow.state.value).toBe('error');
			expect(flow.errorKey.value).toBe('page.errors.missingToken');
		}
	);

	it('maps a reason from the page table', async () => {
		const flow = setup(async () => fail('expired'));
		await flushPromises();
		expect(flow.state.value).toBe('error');
		expect(flow.errorKey.value).toBe('page.errors.expired');
		expect(flow.reason.value).toBe('expired');
	});

	it('maps a reason the table does not name to the fallback key', async () => {
		const flow = setup(async () => fail('invalid_signature'));
		await flushPromises();
		expect(flow.errorKey.value).toBe('page.errors.invalid');
	});

	it('maps an unreachable server and a thrown action to the unreachable key', async () => {
		const offline = setup(async () => fail(PUBLIC_TOKEN_REASONS.network));
		const garbage = setup(async () => fail(PUBLIC_TOKEN_REASONS.badResponse));
		const thrown = setup(async () => {
			throw new Error('Invalid or expired unsubscribe link');
		});
		await flushPromises();

		expect(offline.errorKey.value).toBe('page.errors.verifyFailed');
		expect(garbage.errorKey.value).toBe('page.errors.verifyFailed');
		expect(thrown.errorKey.value).toBe('page.errors.verifyFailed');
	});

	it('falls back to the fallback key when no unreachable key is given', async () => {
		const flow = setup(async () => fail(PUBLIC_TOKEN_REASONS.network), {
			unreachableKey: undefined,
		});
		await flushPromises();
		expect(flow.errorKey.value).toBe('page.errors.invalid');
	});

	it('shows the shared rate-limit copy unless the page names its own', async () => {
		const shared = setup(async () => fail(PUBLIC_TOKEN_REASONS.rateLimited));
		const own = setup(async () => fail(PUBLIC_TOKEN_REASONS.rateLimited), {
			reasons: { rate_limited: 'page.errors.slowDown' },
		});
		await flushPromises();
		expect(shared.errorKey.value).toBe('recipient.shared.rateLimited');
		expect(own.errorKey.value).toBe('page.errors.slowDown');
	});
});

describe('useRecipientTokenFlow — run', () => {
	async function ready() {
		const flow = setup(async () => ok({ subscribed: true }));
		await flushPromises();
		return flow;
	}

	it('runs the action with the token, flags processing and ends in done', async () => {
		const flow = await ready();
		let resolve!: (value: PublicTokenResult<{ alreadyUnsubscribed: boolean }>) => void;
		const action = vi.fn(
			() => new Promise<PublicTokenResult<{ alreadyUnsubscribed: boolean }>>((r) => (resolve = r))
		);

		const pending = flow.run(action, { fallbackKey: 'page.errors.processFailed' });
		expect(action).toHaveBeenCalledWith('tok');
		expect(flow.isProcessing.value).toBe(true);
		// A second click while the first is in flight does nothing.
		expect(await flow.run(action, { fallbackKey: 'x' })).toBeNull();
		expect(action).toHaveBeenCalledTimes(1);

		resolve(ok({ alreadyUnsubscribed: true }));
		expect(await pending).toEqual(ok({ alreadyUnsubscribed: true }));
		expect(flow.isProcessing.value).toBe(false);
		expect(flow.state.value).toBe('done');
	});

	it('never renders the error message of a failed action, only a key', async () => {
		const flow = await ready();
		await flow.run(
			async () => {
				throw new Error('Failed to unsubscribe');
			},
			{ fallbackKey: 'page.errors.processFailed' }
		);
		expect(flow.state.value).toBe('error');
		expect(flow.errorKey.value).toBe('page.errors.processFailed');

		await flow.run(async () => fail('expired'), { fallbackKey: 'page.errors.processFailed' });
		expect(flow.errorKey.value).toBe('page.errors.expired');
	});

	it('keeps the state on an inline failure and clears the key on the next run', async () => {
		const flow = await ready();
		await flow.run(async () => fail('update_failed'), {
			fallbackKey: 'page.errors.saveFailed',
			inline: true,
		});
		expect(flow.state.value).toBe('ready');
		expect(flow.errorKey.value).toBe('page.errors.saveFailed');

		await flow.run(async () => ok({}), { fallbackKey: 'page.errors.saveFailed', inline: true });
		expect(flow.state.value).toBe('ready');
		expect(flow.errorKey.value).toBeNull();
	});

	it('does nothing without a token', async () => {
		query = {};
		const flow = setup(async () => ok({}));
		await flushPromises();
		const action = vi.fn(async () => ok({}));
		expect(await flow.run(action, { fallbackKey: 'x' })).toBeNull();
		expect(action).not.toHaveBeenCalled();
	});
});

describe('useRecipientTokenFlow — the token leaves the address bar', () => {
	beforeEach(() => {
		window.history.replaceState(
			{ current: '/unsubscribe?lang=de&token=tok' },
			'',
			'/unsubscribe?lang=de&token=tok#top'
		);
	});

	it('drops only the token from the URL and the router state once mounted', async () => {
		setup(async () => ok({}));
		await flushPromises();

		expect(window.location.pathname + window.location.search + window.location.hash).toBe(
			'/unsubscribe?lang=de#top'
		);
		expect(window.history.state).toEqual({ current: '/unsubscribe?lang=de' });
	});

	it('still runs and retries the action with the token after removing it', async () => {
		const flow = setup(async () => ok({}));
		await flushPromises();
		const action = vi.fn(async () => fail('update_failed'));

		await flow.run(action, { fallbackKey: 'x', inline: true });
		await flow.run(action, { fallbackKey: 'x', inline: true });

		expect(action).toHaveBeenNthCalledWith(1, 'tok');
		expect(action).toHaveBeenNthCalledWith(2, 'tok');
	});

	it('verifies again after a reload of the cleaned URL', async () => {
		setup(async () => ok({}));
		await flushPromises();

		// The reloaded page: same path, no token in the query.
		query = {};
		const verify = vi.fn(async () => ok({ subscribed: true }));
		const reloaded = setup(verify);
		await flushPromises();

		expect(verify).toHaveBeenCalledWith('tok');
		expect(reloaded.state.value).toBe('ready');
	});
});
