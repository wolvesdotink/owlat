/**
 * The sign-in chip copies the code or opens the link without opening the row
 * it sits in, names the sender's domain, and is gone once the code expired.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, shallowRef } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxSignInCodeChip from '../PostboxSignInCodeChip.vue';

const NOW = Date.UTC(2026, 10, 2, 12);
const now = shallowRef(NOW);
const showToast = vi.fn();

vi.mock('~/composables/postbox/usePostboxListClock', () => ({ usePostboxRowNow: () => now }));

beforeAll(() => {
	// The copy checks the code is still live against the real clock.
	vi.setSystemTime(NOW);
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useToast', () => ({ showToast }));
});

afterAll(() => {
	vi.useRealTimers();
});

afterEach(() => {
	now.value = NOW;
	showToast.mockReset();
	vi.restoreAllMocks();
});

const code = {
	kind: 'code' as const,
	value: '482913',
	senderDomain: 'northwind.example',
	expiresAt: NOW + 60_000,
};
const link = {
	kind: 'link' as const,
	value: 'https://app.fabrikam.example/login/magic?token=1',
	senderDomain: 'fabrikam.example',
	expiresAt: NOW + 60_000,
};

/** The chip inside a clickable row, as the list renders it. */
function mountInRow(signInCode: typeof code | typeof link) {
	const onRowClick = vi.fn();
	const Row = defineComponent({
		setup: () => () =>
			h('div', { onClick: onRowClick }, [h(PostboxSignInCodeChip, { signInCode })]),
	});
	const wrapper = mount(Row, {
		global: { plugins: [createTestI18n()] },
	});
	return { wrapper, onRowClick };
}

describe('PostboxSignInCodeChip', () => {
	it('copies the code and names the sender domain, without opening the row', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		const { wrapper, onRowClick } = mountInRow(code);
		const chip = wrapper.get('[data-testid="sign-in-code-chip"]');
		expect(chip.text()).toContain('482913');
		expect(chip.text()).toContain('northwind.example');
		expect(chip.attributes('aria-label')).toBe('Copy sign-in code 482913 from northwind.example');

		await chip.trigger('click');
		await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Code copied'));
		expect(writeText).toHaveBeenCalledWith('482913');
		expect(onRowClick).not.toHaveBeenCalled();
	});

	it('opens the sign-in link in a new window, without opening the row', async () => {
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		const { wrapper, onRowClick } = mountInRow(link);
		const chip = wrapper.get('[data-testid="sign-in-code-chip"]');
		expect(chip.text()).toContain('fabrikam.example');

		await chip.trigger('click');
		expect(open).toHaveBeenCalledWith(link.value, '_blank', 'noopener,noreferrer');
		expect(onRowClick).not.toHaveBeenCalled();
	});

	it('is gone once the code expired', async () => {
		const { wrapper } = mountInRow(code);
		expect(wrapper.find('[data-testid="sign-in-code-chip"]').exists()).toBe(true);
		now.value = code.expiresAt;
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-testid="sign-in-code-chip"]').exists()).toBe(false);
	});
});
