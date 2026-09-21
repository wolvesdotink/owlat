// @vitest-environment happy-dom
/**
 * PostboxSealedMailNudge — the one-time pointer that turns a lock glyph into an
 * explanation (plan idea 55).
 *
 * "Once" is the whole contract, and it is a per-USER promise, not a per-browser
 * one: the strip disappears by writing a server preference, so a second device
 * does not get nudged again. Following the link counts as dismissal, because
 * arriving at the page is the nudge's entire purpose.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxSealedMailNudge from '../PostboxSealedMailNudge.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const flagOn = ref(true);
const hasSeen = ref(false);
const dismiss = vi.fn(async () => {});
const navigate = vi.fn(async (_to: string) => {});

beforeAll(() => {
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (name: string) => name === 'sealedMail' && flagOn.value,
	}));
	vi.stubGlobal('usePostboxSettings', () => ({
		hasSeenSealedMailNudge: hasSeen,
		dismissSealedMailNudge: dismiss,
	}));
	vi.stubGlobal('navigateTo', navigate);
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	flagOn.value = true;
	hasSeen.value = false;
	dismiss.mockClear();
	navigate.mockClear();
});

const iconStub = { props: ['name'], template: '<span />' };
const mountNudge = () =>
	mount(PostboxSealedMailNudge, {
		global: { plugins: [createTestI18n()], stubs: { Icon: iconStub } },
	});

describe('PostboxSealedMailNudge', () => {
	it('explains the change and offers the way to act on it', () => {
		const wrapper = mountNudge();
		expect(wrapper.find('[data-testid="sealed-mail-nudge"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('only you can read it');
		expect(wrapper.text()).toContain('save your recovery kit');
	});

	it('says nothing on an instance that never turned sealing on', () => {
		flagOn.value = false;
		expect(mountNudge().find('[data-testid="sealed-mail-nudge"]').exists()).toBe(false);
	});

	it('stays gone once the user has dismissed it — a per-user fact, not a local one', () => {
		hasSeen.value = true;
		expect(mountNudge().find('[data-testid="sealed-mail-nudge"]').exists()).toBe(false);
	});

	it('records the dismissal on the server', async () => {
		const wrapper = mountNudge();
		await wrapper.find('[data-testid="sealed-mail-nudge-dismiss"]').trigger('click');
		await flushPromises();
		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	it('counts following the link as done, and lands on the card it points at', async () => {
		const wrapper = mountNudge();
		await wrapper.find('[data-testid="sealed-mail-nudge-open"]').trigger('click');
		await flushPromises();
		expect(dismiss).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledWith('/dashboard/preferences#sealed-mail');
	});
});
