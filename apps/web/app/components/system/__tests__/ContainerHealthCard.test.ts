// @vitest-environment happy-dom
/**
 * The container health card, moved out of the System & updates page: it reads
 * the updater's /health once on mount and names each outcome.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

import ContainerHealthCard from '../ContainerHealthCard.vue';

const fetchMock = vi.fn();

// Nuxt auto-imports; left in place so the setup file's `ref`/`computed` stay.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, $fetch: fetchMock });
});

async function mountCard() {
	const wrapper = mount(ContainerHealthCard, {
		global: { plugins: [createTestI18n()] },
	});
	await flushPromises();
	return wrapper;
}

describe('ContainerHealthCard', () => {
	it('lists the containers the updater reports', async () => {
		fetchMock.mockResolvedValueOnce({
			containers: [{ service: 'web', state: 'running', imageTag: '0.5.6' }],
		});
		const wrapper = await mountCard();

		expect(fetchMock).toHaveBeenCalledWith('/api/internal/updater-health');
		expect(wrapper.find('tbody').text()).toContain('web');
		expect(wrapper.find('tbody').text()).toContain('0.5.6');
		expectFullyLocalized(wrapper);
	});

	it('says the read failed instead of loading forever', async () => {
		fetchMock.mockRejectedValueOnce(new Error('updater unreachable'));
		const wrapper = await mountCard();

		expect(wrapper.text()).toContain('Could not read container status');
	});

	it('names a deployment that reports no containers', async () => {
		fetchMock.mockResolvedValueOnce({ status: 'ok' });
		const wrapper = await mountCard();

		expect(wrapper.text()).toContain('No containers reported by this deployment.');
	});
});
