/**
 * Which navigation request is the latest, as a guard that acts outside the
 * router sees it. Every way a request reaches the router counts, including a
 * request for the page already shown, which runs no guard.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter, type Router, type RouterHistory } from 'vue-router';
import { defineComponent } from 'vue';
import { trackNavigationRequests } from '../navigationRequests';

const Page = defineComponent({ render: () => null });

function testRouter(history: RouterHistory = createMemoryHistory()): Router {
	return createRouter({
		history,
		routes: [
			{ path: '/inbox', component: Page },
			{ path: '/settings', name: 'settings', component: Page },
			{ path: '/old-settings', redirect: '/settings' },
		],
	});
}

const stops: Array<() => void> = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

/**
 * A history that, like a browser's, reports a traversal in a later task:
 * `deliver()` stands for that task.
 */
function laterTraversalHistory() {
	const history = createMemoryHistory();
	const go = history.go.bind(history);
	const queued: Array<() => void> = [];
	history.go = (delta, triggerListeners) => void queued.push(() => go(delta, triggerListeners));
	return { history, deliver: () => queued.shift()?.() };
}

async function tracked(history?: RouterHistory) {
	const router = testRouter(history);
	await router.push('/inbox');
	const requests = trackNavigationRequests(router);
	stops.push(requests.stop);
	return { router, requests };
}

describe('trackNavigationRequests', () => {
	it('knows of no request before the first one', async () => {
		const { router, requests } = await tracked();
		expect(requests.isLatest(router.currentRoute.value)).toBe(false);
	});

	it('follows push and replace, a request for the page already shown included', async () => {
		const { router, requests } = await tracked();
		await router.push('/settings?tab=general');
		expect(requests.isLatest(router.resolve('/settings?tab=general'))).toBe(true);

		await router.replace('/inbox');
		expect(requests.isLatest(router.resolve('/settings?tab=general'))).toBe(false);
		expect(requests.isLatest(router.resolve('/inbox'))).toBe(true);

		await router.push('/settings');
		await router.push('/settings'); // the page already shown: no guard runs
		expect(requests.isLatest(router.resolve('/settings'))).toBe(true);
		await router.push('/inbox');
		await router.push('/inbox');
		expect(requests.isLatest(router.resolve('/settings'))).toBe(false);
	});

	it('follows back and forward through the history', async () => {
		const { router, requests } = await tracked();
		await router.push('/settings');
		router.back();
		expect(requests.isLatest(router.resolve('/inbox'))).toBe(true);
		expect(requests.isLatest(router.resolve('/settings'))).toBe(false);
	});

	it('knows no latest destination while a traversal waits for the history to name it', async () => {
		const { history, deliver } = laterTraversalHistory();
		const { router, requests } = await tracked(history);
		await router.push('/settings');
		await router.push('/inbox');

		router.back();
		expect(requests.isLatest(router.resolve('/inbox'))).toBe(false);
		expect(requests.isLatest(router.resolve('/settings'))).toBe(false);
		deliver();
		expect(requests.isLatest(router.resolve('/settings'))).toBe(true);

		router.forward();
		expect(requests.isLatest(router.resolve('/settings'))).toBe(false);
		deliver();
		expect(requests.isLatest(router.resolve('/inbox'))).toBe(true);

		router.go(-1);
		expect(requests.isLatest(router.resolve('/inbox'))).toBe(false);
		deliver();
		expect(requests.isLatest(router.resolve('/settings'))).toBe(true);
	});

	it('matches a destination reached through a redirect', async () => {
		const { router, requests } = await tracked();
		await router.push('/old-settings');
		expect(router.currentRoute.value.fullPath).toBe('/settings');
		expect(requests.isLatest(router.currentRoute.value)).toBe(true);
	});

	it('ignores a request the router refuses, and still lets it throw', async () => {
		const { router, requests } = await tracked();
		await router.push('/settings');
		expect(() => router.push({ name: 'missing' })).toThrow();
		expect(requests.isLatest(router.resolve('/settings'))).toBe(true);
	});

	it('gives the router back its own methods once stopped', async () => {
		const router = testRouter();
		const { push, replace, go, back, forward } = router;
		const requests = trackNavigationRequests(router);
		expect(router.push).not.toBe(push);
		expect(router.back).not.toBe(back);
		requests.stop();
		expect(router.push).toBe(push);
		expect(router.replace).toBe(replace);
		expect(router.go).toBe(go);
		expect(router.back).toBe(back);
		expect(router.forward).toBe(forward);

		await router.push('/settings');
		expect(requests.isLatest(router.resolve('/settings'))).toBe(false);
	});
});
