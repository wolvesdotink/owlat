// @vitest-environment happy-dom
/**
 * The folder list and the open message are one page with one constant key, so
 * PostboxLayout (rail, list, reader, their subscriptions, loaded pages, scroll
 * and focus) stays mounted across opens, j/k, back and folder switches.
 *
 * Nuxt keys a page by `meta.key`, falling back to the interpolated route path.
 * The harness below renders pages through a real vue-router with that same
 * keying rule; the control case shows the path fallback would remount the
 * layout on every open, so the stable-key assertions are not vacuous.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, type Component } from 'vue';
import {
	RouterView,
	createMemoryHistory,
	createRouter,
	useRoute,
	type RouteLocationNormalizedLoaded,
	type RouteMeta,
	type Router,
} from 'vue-router';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { POSTBOX_PAGE_KEY, postboxPageTransition } from '~/utils/postboxPageTransition';
import FolderPage from '../[folder]/[[messageId]].vue';

let capturedMeta: RouteMeta = {};
let layoutMounts = 0;
let layoutUnmounts = 0;

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useHead: () => {},
		definePageMeta: (meta: RouteMeta) => {
			capturedMeta = meta;
		},
		useRoute,
		useAuth: () => ({ user: ref({ id: 'user-1' }) }),
		// The body-cache scope has its own spec (usePostboxBodyCacheScope.test.ts).
		usePostboxBodyCacheScope: () => {},
		usePostboxMailbox: () => ({
			currentMailbox: ref({ _id: 'mailbox-1' }),
			isLoading: ref(false),
			error: ref(null),
		}),
	});
});

const PostboxLayoutStub = defineComponent({
	name: 'PostboxLayout',
	inheritAttrs: false,
	setup(_p, { attrs }) {
		layoutMounts++;
		return () => h('div', { 'data-testid': 'PostboxLayout', ...attrs });
	},
	unmounted() {
		layoutUnmounts++;
	},
});

const passThrough = (name: string) =>
	defineComponent({
		name,
		setup:
			(_p, { slots }) =>
			() =>
				h('div', slots.default?.()),
	});
const empty = (name: string) => defineComponent({ name, setup: () => () => h('div') });

/** Nuxt's `generateRouteKey`: `meta.key` (string or function), else the interpolated path. */
function pageKey(route: RouteLocationNormalizedLoaded, component: Component): string {
	const record = route.matched.find((m) => m.components?.['default'] === component);
	const source = record?.meta['key'];
	if (typeof source === 'function') return String(source(route));
	if (typeof source === 'string') return source;
	return record ? route.path : '';
}

const Host = defineComponent({
	setup: () => () =>
		h(RouterView, null, {
			default: ({
				Component,
				route,
			}: {
				Component: unknown;
				route: RouteLocationNormalizedLoaded;
			}) =>
				Component
					? h(Component as Component, {
							key: pageKey(route, (Component as { type: Component }).type),
						})
					: null,
		}),
});

let wrapper: VueWrapper | null = null;

async function mountAt(meta: RouteMeta, path: string): Promise<Router> {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [{ path: '/dashboard/postbox/:folder/:messageId?', component: FolderPage, meta }],
	});
	await router.push(path);
	await router.isReady();
	wrapper = mount(Host, {
		global: {
			plugins: [router, createTestI18n()],
			components: {
				PostboxLayout: PostboxLayoutStub,
				PostboxMailboxGuard: passThrough('PostboxMailboxGuard'),
				PostboxComposerStack: empty('PostboxComposerStack'),
				DashboardGettingStarted: empty('DashboardGettingStarted'),
				UiErrorAlert: empty('UiErrorAlert'),
			},
		},
	});
	await flushPromises();
	return router;
}

async function go(router: Router, path: string) {
	await router.push(path);
	await flushPromises();
}

const layout = () => wrapper!.get('[data-testid="PostboxLayout"]');

beforeEach(async () => {
	// Capture the page's real definePageMeta argument once, then reset counters.
	if (!capturedMeta['key']) {
		await mountAt({}, '/dashboard/postbox/inbox');
		wrapper?.unmount();
		wrapper = null;
	}
	layoutMounts = 0;
	layoutUnmounts = 0;
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

describe('the Postbox folder page', () => {
	it('declares a constant page key and the in-Postbox transition middleware', () => {
		// A string, not a function of the route: nothing about the folder or the
		// message can change it.
		expect(capturedMeta['key']).toBe(POSTBOX_PAGE_KEY);
		expect(capturedMeta['middleware']).toEqual(['auth', postboxPageTransition]);
	});

	it('keeps PostboxLayout mounted across opens, j/k, back and folder switches', async () => {
		const router = await mountAt(capturedMeta, '/dashboard/postbox/inbox');
		expect(layoutMounts).toBe(1);
		expect(layout().attributes('active-message-id')).toBeUndefined();

		await go(router, '/dashboard/postbox/inbox/msg-1');
		expect(layout().attributes('active-message-id')).toBe('msg-1');

		// j/k: the next message in the same folder.
		await go(router, '/dashboard/postbox/inbox/msg-2');
		expect(layout().attributes('active-message-id')).toBe('msg-2');

		// Browser back lands on the previous message.
		router.back();
		await flushPromises();
		expect(layout().attributes('active-message-id')).toBe('msg-1');

		// Folder switch, then an open in the new folder.
		await go(router, '/dashboard/postbox/sent');
		expect(layout().attributes('folder-role')).toBe('sent');
		await go(router, '/dashboard/postbox/sent/msg-9');
		expect(layout().attributes('active-message-id')).toBe('msg-9');

		expect(layoutMounts).toBe(1);
		expect(layoutUnmounts).toBe(0);
	});

	it('control: keyed by path, the same navigations would remount the layout', async () => {
		const router = await mountAt({}, '/dashboard/postbox/inbox');
		await go(router, '/dashboard/postbox/inbox/msg-1');
		await go(router, '/dashboard/postbox/inbox/msg-2');
		expect(layoutMounts).toBe(3);
		expect(layoutUnmounts).toBe(2);
	});
});
