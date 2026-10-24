/**
 * The layouts' reveal wiring: the hash is resolved through the registry lookup
 * the layout passes (an unknown id is ignored), on mount for a deep link opened
 * fresh and again on every in-app navigation, and leaving the layout cancels a
 * reveal still waiting for its target.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { withSetup } from '~/__tests__/withSetup';
import { useSettingsAnchorReveal } from '../useSettingsAnchorReveal';

const route = reactive({ path: '/dashboard/admin/instance/brand-kit', hash: '', fullPath: '' });
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
let scrolled: string[];
const mounted: (() => void)[] = [];

/** Mount the layout's wiring; afterEach takes every instance down again. */
function mountReveal() {
	const { unmount } = withSetup(() => useSettingsAnchorReveal(resolve));
	mounted.push(unmount);
	return unmount;
}

function go(path: string, hash: string) {
	route.path = path;
	route.hash = hash;
	route.fullPath = `${path}${hash}`;
}

const DECLARED: Record<string, string> = {
	'/dashboard/admin/instance/brand-kit': 'brand-colors',
	'/dashboard/admin/delivery/webhooks': 'webhook-signing',
};
const resolve = vi.fn((path: string, hash: string) =>
	DECLARED[path] && hash === `#${DECLARED[path]}` ? DECLARED[path] : null
);

function addTarget(id: string) {
	const el = document.createElement('section');
	el.id = id;
	document.body.append(el);
	return el;
}

beforeEach(() => {
	vi.useFakeTimers();
	scrolled = [];
	document.body.innerHTML = '';
	resolve.mockClear();
	go('/dashboard/admin/instance/brand-kit', '');
	vi.stubGlobal('useRoute', () => route);
	HTMLElement.prototype.scrollIntoView = function () {
		scrolled.push(this.id);
	};
});

afterEach(() => {
	for (const unmount of mounted.splice(0)) unmount();
	vi.useRealTimers();
	HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

describe('useSettingsAnchorReveal', () => {
	it('reveals a deep link that was open when the layout mounted', () => {
		addTarget('brand-colors');
		go('/dashboard/admin/instance/brand-kit', '#brand-colors');
		mountReveal();
		expect(scrolled).toEqual(['brand-colors']);
	});

	it('reveals on in-app navigation once the next page renders the target', async () => {
		mountReveal();
		expect(scrolled).toEqual([]);

		go('/dashboard/admin/delivery/webhooks', '#webhook-signing');
		await nextTick();
		addTarget('webhook-signing');
		await Promise.resolve();

		expect(scrolled).toEqual(['webhook-signing']);
	});

	it('ignores an id the registry does not declare', async () => {
		addTarget('__nuxt');
		mountReveal();
		go('/dashboard/admin/instance/brand-kit', '#__nuxt');
		await nextTick();
		expect(resolve).toHaveBeenLastCalledWith('/dashboard/admin/instance/brand-kit', '#__nuxt');
		expect(scrolled).toEqual([]);
	});

	it('stops waiting when the layout goes away', async () => {
		go('/dashboard/admin/instance/brand-kit', '#brand-colors');
		const { unmount } = withSetup(() => useSettingsAnchorReveal(resolve));
		unmount();
		addTarget('brand-colors');
		await Promise.resolve();
		expect(scrolled).toEqual([]);
	});
});
