// @vitest-environment happy-dom
/**
 * PostboxKeyChangeBanner — the Signal-style key-change banner (Sealed Mail E5).
 *
 * The load-bearing behaviour: "Accept new key" is the ONLY re-pin path across an
 * unsigned key change, and it calls the E2 mutation
 * `api.e2ee.recipientKeys.reacceptKeyChange` with the recipient's address, then
 * emits `accepted` on success. A failed re-accept surfaces an inline error and
 * does NOT emit accepted. Because re-pinning is an admin-only mutation, the
 * accept button shows ONLY to admins; members get honest "ask an admin" copy
 * instead of a button that would always fail.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxKeyChangeBanner from '../PostboxKeyChangeBanner.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const reacceptRun = vi.fn(async (_args: unknown): Promise<unknown> => undefined);
const reacceptLoading = ref(false);
// The banner reads `isAdmin` from usePermissions() to gate the accept button.
const isAdmin = ref(true);

beforeAll(() => {
	vi.stubGlobal('useBackendOperation', () => ({
		run: reacceptRun,
		isLoading: reacceptLoading,
		inlineError: ref(null),
	}));
	vi.stubGlobal('usePermissions', () => ({ isAdmin }));
	// The banner renders its copy through vue-i18n; `useI18n` is a Nuxt auto-import.
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	reacceptLoading.value = false;
	isAdmin.value = true;
	reacceptRun.mockReset();
	reacceptRun.mockResolvedValue({
		ok: true,
		result: { reaccepted: true, pinnedFingerprint: 'NEWFP' },
	});
});

const iconStub = { props: ['name'], template: '<span />' };

function mountBanner(over: Record<string, unknown> = {}) {
	return mount(PostboxKeyChangeBanner, {
		props: {
			address: 'bob@b.test',
			oldFingerprint: 'OLDFP0011223344',
			newFingerprint: 'NEWFP5566778899',
			...over,
		},
		global: { plugins: [createTestI18n()], stubs: { Icon: iconStub } },
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
		reacceptRun.mockResolvedValue({ ok: true, result: { reaccepted: false } });
		const wrapper = mountBanner();
		await wrapper.find('[data-testid="key-change-accept"]').trigger('click');
		await flushPromises();

		expect(wrapper.emitted('accepted')).toBeUndefined();
		expect(wrapper.find('[data-testid="key-change-error"]').exists()).toBe(true);
	});

	it('a non-admin sees "ask an admin" copy and NO accept button (re-pin is admin-only)', () => {
		isAdmin.value = false;
		const wrapper = mountBanner();
		// The warning still shows — everyone should know sealing paused — but the
		// admin-only action is replaced with honest guidance, not a failing button.
		expect(wrapper.find('[data-testid="key-change-banner"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="key-change-accept"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="key-change-admin-only"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Ask a workspace admin');
	});
});

/**
 * Plan idea 54. A key rotating is routine; a key rotating away from one a human
 * physically checked is the shape of an interception, and the banner has to be
 * able to tell those apart — otherwise verifying a contact buys nothing at the
 * one moment it was supposed to matter.
 */
describe('PostboxKeyChangeBanner · a change away from a VERIFIED key', () => {
	it('says so, above and beyond the ordinary warning', () => {
		const wrapper = mountBanner({ wasVerified: true });
		const line = wrapper.find('[data-testid="key-change-was-verified"]');
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('You had verified the previous key');
		expect(line.text()).toContain('bob@b.test');
	});

	it('stays quiet when nobody had checked the old key', () => {
		expect(mountBanner().find('[data-testid="key-change-was-verified"]').exists()).toBe(false);
		expect(
			mountBanner({ wasVerified: false }).find('[data-testid="key-change-was-verified"]').exists()
		).toBe(false);
	});

	it('changes nothing about how the key is accepted — the same explicit re-pin', async () => {
		const wrapper = mountBanner({ wasVerified: true });
		await wrapper.find('[data-testid="key-change-accept"]').trigger('click');
		await flushPromises();
		expect(reacceptRun).toHaveBeenCalledWith({ address: 'bob@b.test' });
	});
});
