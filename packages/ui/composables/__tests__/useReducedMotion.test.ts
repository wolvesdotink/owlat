// @vitest-environment happy-dom
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
import { prefersReducedMotion, REDUCED_MOTION_QUERY, useReducedMotion } from '../useReducedMotion';

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
