/**
 * The container health card, moved out of the System & updates page: it reads
 * the updater's /health once on mount and names each outcome.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { DESKTOP_SITE_URL, onDesktop } from '~/__tests__/desktopRuntimeFixture';
import en from '~~/i18n/locales/en.json';

import ContainerHealthCard from '../ContainerHealthCard.vue';

const fetchMock = vi.fn();
const openExternal = vi.hoisted(() => vi.fn(async (_url: string) => undefined));
vi.mock('@owlat/desktop/src/shell', () => ({ openExternal }));

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

	// The desktop app is a static build: `/api/internal/updater-health` does not
	// exist there, so the card must not read it and must not offer a Refresh
	// that cannot work.
	it('on desktop, reads nothing and opens the instance page in the browser', async () => {
		onDesktop();
		fetchMock.mockClear();
		const wrapper = await mountCard();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(wrapper.text()).not.toContain(en.common.refresh);
		const notice = wrapper.find('[data-testid="instance-page-notice"]');
		expect(notice.text()).toContain(en.dashboard.admin.system.index.containers.onInstance);

		await notice.find('button').trigger('click');
		await flushPromises();
		expect(openExternal).toHaveBeenCalledWith(`${DESKTOP_SITE_URL}/dashboard/admin/system`);
	});
});
