/**
 * The "changed from default" marker: absent on a default value, a dot plus a
 * labelled Reset otherwise, and the Reset asks the owner rather than writing
 * anything itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import ResetToDefault from '../ResetToDefault.vue';

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountMarker(props: { changed: boolean; disabled?: boolean }) {
	return mount(ResetToDefault, {
		props: { label: 'Density', ...props },
		global: { plugins: [createTestI18n()] },
	});
}

describe('ResetToDefault', () => {
	it('renders nothing while the value is the default', () => {
		expect(mountMarker({ changed: false }).find('[data-testid="setting-reset"]').exists()).toBe(
			false
		);
	});

	it('shows the dot and a Reset named after the setting once it differs', () => {
		const marker = mountMarker({ changed: true });
		const button = marker.get('button');
		expect(button.text()).toBe('Reset');
		expect(button.attributes('aria-label')).toBe('Reset Density to its default');
		expect(marker.find('[aria-hidden="true"].rounded-full').exists()).toBe(true);
		expectFullyLocalized(marker);
	});

	it('asks its owner to reset', async () => {
		const marker = mountMarker({ changed: true });
		await marker.get('button').trigger('click');
		expect(marker.emitted('reset')).toHaveLength(1);
	});

	it('stays put while disabled', async () => {
		const marker = mountMarker({ changed: true, disabled: true });
		expect(marker.get('button').attributes('disabled')).toBeDefined();
		await marker.get('button').trigger('click');
		expect(marker.emitted('reset')).toBeUndefined();
	});
});
