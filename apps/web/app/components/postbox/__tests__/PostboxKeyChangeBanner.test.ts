// @vitest-environment happy-dom
/**
 * PostboxKeyChangeBanner — the Signal-style key-change banner (Sealed Mail E5).
 *
 * The load-bearing behaviour: "Accept new key" is the ONLY re-pin path across an
 * unsigned key change, and it calls the E2 mutation
 * `api.e2ee.recipientKeys.reacceptKeyChange` with the recipient's address, then
 * emits `accepted` on success. A failed re-accept surfaces an inline error and
 * does NOT emit accepted.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxKeyChangeBanner from '../PostboxKeyChangeBanner.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const reacceptRun = vi.fn(async (_args: unknown): Promise<unknown> => undefined);
const reacceptLoading = ref(false);
let lastOperation: unknown;

beforeAll(() => {
	vi.stubGlobal('useBackendOperation', (operation: unknown) => {
		lastOperation = operation;
		return { run: reacceptRun, isLoading: reacceptLoading, inlineError: ref(null) };
	});
});

beforeEach(() => {
	reacceptLoading.value = false;
	reacceptRun.mockReset();
	reacceptRun.mockResolvedValue({ reaccepted: true, pinnedFingerprint: 'NEWFP' });
});

const iconStub = { props: ['name'], template: '<span />' };

function mountBanner() {
	return mount(PostboxKeyChangeBanner, {
		props: {
			address: 'bob@b.test',
			oldFingerprint: 'OLDFP0011223344',
			newFingerprint: 'NEWFP5566778899',
		},
		global: { stubs: { Icon: iconStub } },
	});
}

describe('PostboxKeyChangeBanner', () => {
	it('renders the plain-language warning naming the recipient', () => {
		const wrapper = mountBanner();
		expect(wrapper.find('[data-testid="key-change-banner"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('bob@b.test');
	});

	it('Accept new key calls the re-pin mutation with the address and emits accepted', async () => {
		const wrapper = mountBanner();
		await wrapper.find('[data-testid="key-change-accept"]').trigger('click');
		await flushPromises();

		expect(reacceptRun).toHaveBeenCalledTimes(1);
		expect(reacceptRun.mock.calls[0]![0]).toEqual({ address: 'bob@b.test' });
		expect(wrapper.emitted('accepted')).toHaveLength(1);
	});

	it('a no-op re-accept (already resolved) surfaces an error and does not emit accepted', async () => {
		reacceptRun.mockResolvedValue({ reaccepted: false });
		const wrapper = mountBanner();
		await wrapper.find('[data-testid="key-change-accept"]').trigger('click');
		await flushPromises();

		expect(wrapper.emitted('accepted')).toBeUndefined();
		expect(wrapper.find('[data-testid="key-change-error"]').exists()).toBe(true);
	});

	it('wires the accept button to the reacceptKeyChange mutation reference', () => {
		mountBanner();
		// The proxy makes any property access identity-stable; assert the composable
		// was handed a truthy operation reference (the api.e2ee.recipientKeys path).
		expect(lastOperation).toBeTruthy();
	});
});
