// @vitest-environment happy-dom
/**
 * The cancellation link's token leaves the URL once read, and the page still
 * works across a reload: a failed attempt can be retried from the cleaned URL,
 * and a token that did its job is not replayed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import CancelDeletionPage from '../cancel-deletion.vue';

const run = vi.fn();
const replace = vi.fn();

function open(query: Record<string, string>) {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ path: '/cancel-deletion', fullPath: '/cancel-deletion', query, hash: '' }),
		useRouter: () => ({ replace, push: vi.fn() }),
		useBackendOperation: () => ({ run }),
	});
	return mount(CancelDeletionPage, {
		global: {
			plugins: [createTestI18n()],
			stubs: { UiSpinner: true, UiButton: true, Icon: true },
		},
	});
}

beforeEach(() => {
	run.mockReset();
	replace.mockClear();
	window.sessionStorage.clear();
});

describe('cancel-deletion — token in the URL', () => {
	it('removes the token from the URL, retries after a reload, and does not replay it once used', async () => {
		run.mockResolvedValueOnce({ ok: false });
		const first = open({ token: 'cancel-token' });
		await flushPromises();
		expect(replace).toHaveBeenCalledWith({ query: {}, hash: '' });
		expect(first.text()).toContain('Cancellation failed');

		run.mockResolvedValueOnce({ ok: true });
		const reloaded = open({});
		await flushPromises();
		expect(run).toHaveBeenLastCalledWith({ userId: '', cancellationToken: 'cancel-token' });
		expect(reloaded.text()).toContain('Deletion cancelled');

		const afterSuccess = open({});
		await flushPromises();
		expect(run).toHaveBeenCalledTimes(2);
		expect(afterSuccess.text()).toContain('Invalid link');
	});
});
