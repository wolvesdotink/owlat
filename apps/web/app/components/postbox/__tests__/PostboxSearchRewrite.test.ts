/**
 * The "Search for: …" offer (PostboxSearchRewrite) under a plain-language search:
 *   - nothing is asked until the person clicks
 *   - the suggestion lands in an editable field and runs only on Search / Enter
 *   - "no operator fits", a budget refusal and a failure each say so in place
 *   - an answer for a query the person already left is dropped
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';

import PostboxSearchRewrite from '../PostboxSearchRewrite.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const run = vi.fn(async (_args: unknown): Promise<unknown> => ({ ok: false }));
const isLoading = ref(false);
let onError: ((op: unknown) => boolean | void) | undefined;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal(
		'useBackendOperation',
		(_action: unknown, opts: { onError?: (op: unknown) => boolean | void }) => {
			onError = opts.onError;
			return { run, isLoading };
		}
	);
});

beforeEach(() => {
	run.mockReset();
	isLoading.value = false;
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(2026, 10, 3, 9, 0));
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	vi.useRealTimers();
});

const buttonStub = defineComponent({
	name: 'UiButton',
	setup:
		(_p, { slots, attrs }) =>
		() =>
			h('button', { ...attrs, type: 'button' }, slots.default?.()),
});

function mountOffer(query = 'the invoice from the hosting company in september') {
	wrapper = mount(PostboxSearchRewrite, {
		props: { query },
		global: {
			plugins: [createTestI18n()],
			components: { UiButton: buttonStub },
			stubs: { Icon: true },
		},
	});
	return wrapper;
}

describe('PostboxSearchRewrite', () => {
	it('asks nothing until clicked, then shows the suggestion to edit and run', async () => {
		run.mockResolvedValueOnce({ ok: true, result: { query: 'invoice has:attachment' } });
		const offer = mountOffer();
		expect(run).not.toHaveBeenCalled();

		await offer.get('[data-testid="search-rewrite-suggest"]').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({
			query: 'the invoice from the hosting company in september',
			today: '2026-11-03',
		});
		const field = offer.get('[data-testid="search-rewrite-query"]');
		expect((field.element as HTMLTextAreaElement).value).toBe('invoice has:attachment');
		expect(offer.emitted('search')).toBeUndefined();

		await field.setValue('invoice from:hetzner.com\nhas:attachment');
		await field.trigger('keydown', { key: 'Enter' });
		expect(offer.emitted('search')).toEqual([['invoice from:hetzner.com has:attachment']]);
	});

	it('says when no operator fits', async () => {
		run.mockResolvedValueOnce({ ok: true, result: { query: null } });
		const offer = mountOffer();
		await offer.get('[data-testid="search-rewrite-suggest"]').trigger('click');
		await flushPromises();
		expect(offer.find('[data-testid="search-rewrite-query"]').exists()).toBe(false);
		expect(offer.get('[data-testid="search-rewrite-none"]').text()).toContain(
			'No search operator fits'
		);
	});

	it('names the spend budget when it refused the call', async () => {
		run.mockImplementationOnce(async () => {
			onError?.({
				category: 'forbidden',
				data: { code: 'AI_BUDGET_EXHAUSTED', reason: 'daily_ceiling' },
			});
			return { ok: false };
		});
		const offer = mountOffer();
		await offer.get('[data-testid="search-rewrite-suggest"]').trigger('click');
		await flushPromises();
		expect(offer.find('[data-testid="search-rewrite-budget"]').exists()).toBe(true);
		expect(offer.text()).not.toContain("Couldn't suggest a search");
	});

	it('says when the suggestion failed', async () => {
		const offer = mountOffer();
		await offer.get('[data-testid="search-rewrite-suggest"]').trigger('click');
		await flushPromises();
		expect(offer.text()).toContain("Couldn't suggest a search");
	});

	it('drops an answer for a query the person already left', async () => {
		let answer!: (value: unknown) => void;
		run.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
		const offer = mountOffer('flight to lisbon');
		await offer.get('[data-testid="search-rewrite-suggest"]').trigger('click');
		await offer.setProps({ query: 'onboarding date' });
		answer({ ok: true, result: { query: 'from:airline lisbon' } });
		await flushPromises();
		expect(offer.find('[data-testid="search-rewrite-query"]').exists()).toBe(false);
	});
});
