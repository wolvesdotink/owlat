/**
 * The "Services out of sync" banner in the desktop app. Its drift probe and its
 * Apply post to server routes (`/api/system/profile-drift`,
 * `/api/system/apply-profiles`) that the static desktop build does not have.
 * On desktop the banner still names the services a flag change affects, reads
 * no route, and offers the instance's features page in the system browser in
 * place of Apply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ProfileSyncBanner from '../ProfileSyncBanner.vue';
import { useProfileSync } from '~/composables/useProfileSync';
import { createTestI18n } from '~/__tests__/i18n';
import { DESKTOP_SITE_URL, onDesktop } from '~/__tests__/desktopRuntimeFixture';
import en from '~~/i18n/locales/en.json';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('~/lib/csrfFetch', () => ({ apiFetch: apiFetchMock }));
const openExternal = vi.hoisted(() => vi.fn(async (_url: string) => undefined));
vi.mock('@owlat/desktop/src/shell', () => ({ openExternal }));

const i18n = createTestI18n();
const fetchMock = vi.fn();

beforeEach(() => {
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('$fetch', fetchMock);
	fetchMock.mockReset();
	apiFetchMock.mockReset();
	openExternal.mockClear();
});

describe('the services banner in the desktop app', () => {
	it('reads no server route and opens the features page in the browser instead of Apply', async () => {
		onDesktop();
		useProfileSync().pendingServices.value = ['mta'];
		const wrapper = mount(ProfileSyncBanner, {
			props: { flags: { inbox: true } },
			global: { plugins: [i18n] },
		});
		await flushPromises();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="profile-sync-services"]').text()).toBe('mta');
		expect(wrapper.find('[data-testid="profile-sync-apply"]').exists()).toBe(false);
		const notice = wrapper.find('[data-testid="instance-page-notice"]');
		expect(notice.text()).toContain(en.components.settings.profileSyncBanner.onInstance);

		await notice.find('button').trigger('click');
		await flushPromises();
		expect(openExternal).toHaveBeenCalledWith(
			`${DESKTOP_SITE_URL}/dashboard/admin/instance/features`
		);
		expect(apiFetchMock).not.toHaveBeenCalled();
	});
});
