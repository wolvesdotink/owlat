/**
 * The shared reduced-motion read, which four hand-rolled `matchMedia` calls
 * used to do four slightly different ways.
 *
 * The case worth a test is the one all four got wrong: `prefers-reduced-motion`
 * is a setting people turn ON mid-session, usually because something on screen
 * is making them ill. A value sampled once at mount keeps animating until the
 * page is reloaded, so the reactive form has to listen — and, because a
 * listener on a global media query outlives the component that added it, it has
 * to be disposed with the scope that created it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import {
	onReducedMotionChange,
	prefersReducedMotion,
	REDUCED_MOTION_QUERY,
	setAppReducedMotion,
	useReducedMotion,
} from '../useReducedMotion';

/** A `matchMedia` whose value can be flipped, with the listeners it holds. */
function installMatchMedia(initial: boolean) {
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	let matches = initial;
	const queries: string[] = [];
	const matchMedia = vi.fn((query: string) => {
		queries.push(query);
		return {
			get matches() {
				return matches;
			},
			media: query,
			addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
				listeners.add(listener);
			},
			removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
				listeners.delete(listener);
			},
		};
	});
	vi.stubGlobal('matchMedia', matchMedia);
	window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
	return {
		queries,
		listeners,
		flip(next: boolean) {
			matches = next;
			for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	setAppReducedMotion(false);
});

describe('prefersReducedMotion', () => {
	it('reads the OS preference on demand', () => {
		installMatchMedia(true);
		expect(prefersReducedMotion()).toBe(true);
	});

	it('asks the one canonical query', () => {
		const media = installMatchMedia(false);
		prefersReducedMotion();
		expect(media.queries).toEqual([REDUCED_MOTION_QUERY]);
	});

	it('reports no preference where there is no matchMedia', () => {
		// SSR, unit tests, an old webview: the same default the CSS media query
		// has, so behaviour off the browser matches a browser with nothing set.
		vi.stubGlobal('matchMedia', undefined);
		window.matchMedia = undefined as unknown as typeof window.matchMedia;
		expect(prefersReducedMotion()).toBe(false);
	});
});

describe('useReducedMotion', () => {
	it('starts at the current preference', () => {
		installMatchMedia(true);
		const scope = effectScope();
		const reduced = scope.run(() => useReducedMotion())!;
		expect(reduced.value).toBe(true);
		scope.stop();
	});

	it('follows a preference turned on MID-SESSION', async () => {
		// The bug in all four hand-rolled copies but one: sampled at mount, never
		// updated, so the animation the person just asked to stop keeps running
		// until they reload the page.
		const media = installMatchMedia(false);
		const scope = effectScope();
		const reduced = scope.run(() => useReducedMotion())!;
		expect(reduced.value).toBe(false);

		media.flip(true);
		await nextTick();

		expect(reduced.value).toBe(true);
		scope.stop();
	});

	it('removes its listener when the owning scope stops', () => {
		const media = installMatchMedia(false);
		const scope = effectScope();
		scope.run(() => useReducedMotion());
		expect(media.listeners.size).toBe(1);

		scope.stop();

		expect(media.listeners.size).toBe(0);
	});

	it('is inert, not broken, without matchMedia', () => {
		vi.stubGlobal('matchMedia', undefined);
		window.matchMedia = undefined as unknown as typeof window.matchMedia;
		const scope = effectScope();
		const reduced = scope.run(() => useReducedMotion())!;
		expect(reduced.value).toBe(false);
		scope.stop();
	});
});

/**
 * The app's own "Reduce motion" switch. It can only add reduction: OS on or
 * app on reduces, and only both off lets things move.
 */
describe('the in-app override', () => {
	it.each([
		{ os: false, app: false, reduced: false },
		{ os: true, app: false, reduced: true },
		{ os: false, app: true, reduced: true },
		{ os: true, app: true, reduced: true },
	])('OS $os + app $app → reduced $reduced', ({ os, app, reduced }) => {
		installMatchMedia(os);
		setAppReducedMotion(app);
		expect(prefersReducedMotion()).toBe(reduced);
		const scope = effectScope();
		expect(scope.run(() => useReducedMotion())!.value).toBe(reduced);
		scope.stop();
	});

	it('applies without matchMedia too', () => {
		vi.stubGlobal('matchMedia', undefined);
		window.matchMedia = undefined as unknown as typeof window.matchMedia;
		setAppReducedMotion(true);
		expect(prefersReducedMotion()).toBe(true);
	});

	it('reaches reactive readers the moment it flips', async () => {
		installMatchMedia(false);
		const scope = effectScope();
		const reduced = scope.run(() => useReducedMotion())!;
		setAppReducedMotion(true);
		await nextTick();
		expect(reduced.value).toBe(true);
		setAppReducedMotion(false);
		await nextTick();
		expect(reduced.value).toBe(false);
		scope.stop();
	});

	it('keeps the OS answer when the app switch goes off', async () => {
		const media = installMatchMedia(false);
		const scope = effectScope();
		const reduced = scope.run(() => useReducedMotion())!;
		setAppReducedMotion(true);
		media.flip(true);
		setAppReducedMotion(false);
		await nextTick();
		expect(reduced.value).toBe(true);
		expect(prefersReducedMotion()).toBe(true);
		scope.stop();
	});
});

describe('onReducedMotionChange', () => {
	it('fires for the OS preference and the app switch, until unsubscribed', () => {
		const media = installMatchMedia(false);
		const listener = vi.fn();
		const stop = onReducedMotionChange(listener);

		media.flip(true);
		setAppReducedMotion(true);
		// Setting the same value again is not a change.
		setAppReducedMotion(true);
		expect(listener).toHaveBeenCalledTimes(2);

		stop();
		expect(media.listeners.size).toBe(0);
		setAppReducedMotion(false);
		media.flip(false);
		expect(listener).toHaveBeenCalledTimes(2);
	});
});
