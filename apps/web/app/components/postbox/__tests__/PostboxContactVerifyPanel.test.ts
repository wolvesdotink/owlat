// @vitest-environment happy-dom
/**
 * PostboxContactVerifyPanel — the "verify this contact" comparison surface
 * (plan idea 54).
 *
 * The behaviour that matters is what the panel SENDS, not how it looks. Three
 * things are pinned here:
 *
 *   - the claim carries the fingerprint being displayed, so the server can
 *     refuse a check of a key that rotated while the panel sat open;
 *   - withdrawing sends no fingerprint at all, because removing a trust claim is
 *     the safe direction and must not be blocked by a stale one;
 *   - the QR code, the written fingerprint and the read-aloud numbers are three
 *     renderings of the SAME key — whichever gets compared, the thing compared
 *     is the key.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxContactVerifyPanel from '../PostboxContactVerifyPanel.vue';
import PostboxQrCode from '../PostboxQrCode.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { openpgpFingerprintUri } from '~/utils/postboxQrCode';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const run = vi.fn(async (_args: unknown): Promise<unknown> => undefined);
const isLoading = ref(false);

beforeAll(() => {
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading, inlineError: ref(null) }));
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	isLoading.value = false;
	run.mockReset();
	run.mockResolvedValue({ ok: true, result: { verified: true } });
});

const FINGERPRINT = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';

const iconStub = { props: ['name'], template: '<span />' };
// Renders `$attrs` (which carries the parent's `@click` and `data-testid`) onto
// a real button, so a click goes through the component's own handler once.
const buttonStub = {
	props: ['size', 'variant', 'disabled'],
	template: '<button v-bind="$attrs"><slot /></button>',
};

function mountPanel(state: 'unverified' | 'verified' | 'stale' = 'unverified') {
	return mount(PostboxContactVerifyPanel, {
		props: { address: 'bob@b.test', fingerprint: FINGERPRINT, state },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub, UiButton: buttonStub, PostboxQrCode },
		},
	});
}

describe('PostboxContactVerifyPanel', () => {
	it('shows the same key three ways: scannable, written and spoken', async () => {
		const wrapper = mountPanel();
		// Written, grouped in fours.
		expect(wrapper.find('[data-testid="verify-fingerprint"]').text()).toBe(
			'AAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555'
		);
		// Spoken: one line per five bytes, twenty numbers in all.
		const spoken = wrapper.findAll('[data-testid="verify-spoken-line"]');
		expect(spoken).toHaveLength(4);
		expect(
			spoken
				.map((n) => n.text())
				.join(' ')
				.split(' ')
		).toHaveLength(20);
		// Scanned: the OPENPGP4FPR URI other tools read, over the same fingerprint.
		const qr = wrapper.findComponent(PostboxQrCode);
		expect(qr.props('value')).toBe(openpgpFingerprintUri(FINGERPRINT));
		expect(qr.props('value')).toContain(FINGERPRINT);
	});

	it('sends the displayed fingerprint with the claim, so a rotation can be refused', async () => {
		const wrapper = mountPanel();
		await wrapper.find('[data-testid="verify-confirm"]').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({
			address: 'bob@b.test',
			verified: true,
			fingerprint: FINGERPRINT,
		});
		expect(wrapper.emitted('changed')).toHaveLength(1);
	});

	it('withdraws without a fingerprint — the safe direction is never blocked', async () => {
		const wrapper = mountPanel('verified');
		// A verified contact is offered withdrawal, not another confirmation.
		expect(wrapper.find('[data-testid="verify-confirm"]').exists()).toBe(false);
		await wrapper.find('[data-testid="verify-withdraw"]').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({ address: 'bob@b.test', verified: false });
	});

	it('offers both moves on a stale verification', () => {
		const wrapper = mountPanel('stale');
		expect(wrapper.find('[data-testid="verify-confirm"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="verify-withdraw"]').exists()).toBe(true);
	});

	it('reports a refusal inline and claims nothing happened', async () => {
		run.mockResolvedValue({ ok: false });
		const wrapper = mountPanel();
		await wrapper.find('[data-testid="verify-confirm"]').trigger('click');
		await flushPromises();
		expect(wrapper.find('[data-testid="verify-error"]').exists()).toBe(true);
		expect(wrapper.emitted('changed')).toBeUndefined();
	});

	it('says what the claim means while it is being made, not afterwards', () => {
		const wrapper = mountPanel();
		const text = wrapper.text();
		// It is shared, and it expires on its own — both said next to the button.
		expect(text).toContain('Everyone in this workspace sees it');
		expect(text).toContain('clears itself if this key ever changes');
	});
});
