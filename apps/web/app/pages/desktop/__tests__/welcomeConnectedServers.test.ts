// @vitest-environment happy-dom
/**
 * /desktop/welcome is not only the first-run screen: the packaged desktop has
 * no in-app login form, so middleware/auth.ts bounces an expired or
 * never-completed session here too.
 *
 * It used to render the first-run splash either way — branded welcome, "set up
 * a new server", nothing else — while the workspace sat saved and active in the
 * store with the titlebar still naming it. The server was, from the user's side,
 * added and then gone: unreachable, unmanageable, with no stated reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { mount } from '@vue/test-utils';
import type { WorkspaceConfig } from '~/lib/desktop/workspaceTypes';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const workspaces = ref<WorkspaceConfig[]>([]);
const connectError = ref<string | null>(null);
const addWorkspace = vi.fn(async () => {});
const removeWorkspace = vi.fn(async () => {});

import WelcomePage from '../welcome.vue';

function workspace(): WorkspaceConfig {
	return {
		id: 'ws-1',
		label: 'acme.test',
		siteUrl: 'https://acme.test',
		convexUrl: 'https://api.acme.test',
		convexSiteUrl: 'https://rest.api.acme.test',
		userId: '',
		tokenRef: 'owlat-ws:ws-1',
		addedAt: 1,
		lastActiveAt: 1,
		accentColor: '#7a8c5a',
	};
}

beforeEach(() => {
	workspaces.value = [];
	connectError.value = null;
	addWorkspace.mockClear();
	removeWorkspace.mockClear();

	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(true) }));
	vi.stubGlobal('useDesktopWorkspaces', () => ({
		workspaces: computed(() => workspaces.value),
		activeId: ref('ws-1'),
		addWorkspace,
		completeConnection: vi.fn(),
		connectError: computed(() => connectError.value),
		clearConnectFailure: vi.fn(),
		switchTo: vi.fn(),
		removeWorkspace,
	}));
});

// The REAL catalog, so these assertions are on the copy the app renders — and
// so a missing key throws (createTestI18n's `missing` handler) rather than
// silently rendering the key path.
function mountPage() {
	return mount(WelcomePage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				DesktopTitlebar: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
				Icon: true,
				UiButton: { template: '<button><slot/></button>' },
			},
		},
	});
}

describe('/desktop/welcome — a bounced session is not a first run', () => {
	it('shows the first-run splash when nothing is connected', () => {
		const text = mountPage().text();
		expect(text).toContain('Your self-hosted home for email, contacts and marketing.');
		expect(text).not.toContain('Sign back in');
	});

	it('lists the connected server instead of the first-run splash', () => {
		workspaces.value = [workspace()];

		const text = mountPage().text();

		expect(text).toContain('Sign back in');
		expect(text).not.toContain('Your self-hosted home for email, contacts and marketing.');
		expect(text).toContain('acme.test');
		expect(text).toContain('https://acme.test');
		// Both ways out of the dead end are on the screen.
		expect(text).toContain('Reconnect');
		expect(text).toContain('Remove');
	});

	it('states why the app bounced back, when it knows', () => {
		workspaces.value = [workspace()];
		connectError.value = 'That server does not support desktop sign-in.';

		expect(mountPage().text()).toContain('That server does not support desktop sign-in.');
	});

	it('reconnects through the same handshake as a fresh connect', async () => {
		workspaces.value = [workspace()];
		const wrapper = mountPage();

		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Reconnect')
			?.trigger('click');

		// Re-authenticating by siteUrl is what lets the composable reuse the
		// existing workspace id rather than adding a duplicate row per retry.
		expect(addWorkspace).toHaveBeenCalledWith('https://acme.test');
	});
});
