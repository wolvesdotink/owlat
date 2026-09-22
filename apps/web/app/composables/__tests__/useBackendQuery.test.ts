import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { ConvexError } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { useBackendQuery } from '../useBackendQuery';
import { withSetup } from '~/__tests__/withSetup';
import { createTestI18n } from '~/__tests__/i18n';
import de from '~~/i18n/locales/de.json';

const query = makeFunctionReference<'query', {}, string[]>('test:list');
const i18n = createTestI18n();
i18n.global.setLocaleMessage('de', de);
let succeed: (data: string[]) => void;
let fail: (error: Error) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
let onUpdate: ReturnType<typeof vi.fn>;
let report: ReturnType<typeof vi.fn>;
let navigate: ReturnType<typeof vi.fn>;
let unmount: (() => void) | undefined;

function build() {
	const setup = withSetup(() => useBackendQuery(query, {}, { timeout: 100 }));
	unmount = setup.unmount;
	return setup.result;
}

beforeEach(() => {
	vi.useFakeTimers();
	i18n.global.locale.value = 'en';
	unsubscribe = vi.fn();
	onUpdate = vi.fn((_query, _args, success, error) => {
		succeed = success;
		fail = error;
		return unsubscribe;
	});
	report = vi.fn();
	navigate = vi.fn();
	vi.stubGlobal('useConvex', () => ({ onUpdate }));
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('usePostHog', () => ({ captureError: report }));
	vi.stubGlobal('navigateTo', navigate);
});
afterEach(() => {
	unmount?.();
	unmount = undefined;
	vi.useRealTimers();
});

describe('backend query failure treatment', () => {
	it('preserves a refusal category, localizes it live, and retries the subscription', async () => {
		const state = build();
		fail(new ConvexError({ category: 'forbidden', message: 'Read permission required' }));
		await nextTick();
		expect(state.operationError.value?.category).toBe('forbidden');
		expect(state.errorMessage.value).toBe('Read permission required');
		expect(state.isLoading.value).toBe(false);
		expect(report).not.toHaveBeenCalled();
		i18n.global.locale.value = 'de';
		expect(state.errorMessage.value).toBe(de.shared.operationError.categories.forbidden);
		state.refetch();
		expect(onUpdate).toHaveBeenCalledTimes(2);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(state.error.value).toBeNull();
		succeed(['loaded']);
		expect(state.data.value).toEqual(['loaded']);
		expect(state.errorMessage.value).toBeUndefined();
	});
	it('normalizes a timeout and reports it once, including after locale changes', async () => {
		const state = build();
		await vi.advanceTimersByTimeAsync(101);
		expect(state.operationError.value?.category).toBe('network');
		expect(state.errorMessage.value).toBe(i18n.global.t('shared.operationError.network'));
		expect(report).toHaveBeenCalledTimes(1);
		i18n.global.locale.value = 'de';
		await nextTick();
		expect(report).toHaveBeenCalledTimes(1);
		state.refetch();
		succeed([]);
		expect(state.data.value).toEqual([]);
		expect(state.error.value).toBeNull();
	});
	it('hides internal exception details and redirects an expired session', async () => {
		const state = build();
		fail(new Error('private database implementation detail'));
		await nextTick();
		expect(state.operationError.value?.category).toBe('internal');
		expect(state.errorMessage.value).not.toContain('private');
		expect(report).toHaveBeenCalledTimes(1);
		state.refetch();
		fail(new ConvexError({ category: 'unauthenticated', message: 'Expired token' }));
		await nextTick();
		expect(navigate).toHaveBeenCalledWith('/auth/login');
		expect(report).toHaveBeenCalledTimes(1);
	});
	it('retains the underlying scope cleanup', () => {
		build();
		unmount?.();
		unmount = undefined;
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
