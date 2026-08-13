import { describe, it, expect, vi, afterEach } from 'vitest';
import { effectScope } from 'vue';
import { useMediaQuery, useEmailBuilderViewport, useDataTableViewport } from '../useMediaQuery';

/**
 * `useMediaQuery` decides whether whole panes render (the postbox folder rail's
 * `:inert`, the email-builder viewport gate), so the three things that can
 * silently break it are pinned here: the first value, the live update, and the
 * listener teardown. A leaked `change` listener keeps a disposed scope's ref
 * alive and flips state for a component that is no longer on screen.
 */

type ChangeListener = (event: MediaQueryListEvent) => void;

/** A `matchMedia` stub whose `change` listeners can be fired by the test. */
function installMatchMedia(matches: boolean) {
	const listeners = new Set<ChangeListener>();
	const mql = {
		matches,
		media: '',
		addEventListener: vi.fn((type: string, listener: ChangeListener) => {
			if (type === 'change') listeners.add(listener);
		}),
		removeEventListener: vi.fn((type: string, listener: ChangeListener) => {
			if (type === 'change') listeners.delete(listener);
		}),
	};
	const matchMedia = vi.fn((query: string) => {
		mql.media = query;
		return mql as unknown as MediaQueryList;
	});
	window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
	return {
		matchMedia,
		mql,
		/** Fire a `change` the way the browser would when the query flips. */
		emit(next: boolean) {
			mql.matches = next;
			for (const listener of listeners) {
				listener({ matches: next } as MediaQueryListEvent);
			}
		},
		get listenerCount() {
			return listeners.size;
		},
	};
}

const originalMatchMedia = window.matchMedia;

afterEach(() => {
	window.matchMedia = originalMatchMedia;
	vi.restoreAllMocks();
});

describe('useMediaQuery', () => {
	it('reports the query result at once — there is no hydration pass to wait for', () => {
		const media = installMatchMedia(false);
		const scope = effectScope();

		const matches = scope.run(() => useMediaQuery('(min-width: 1024px)'))!;

		expect(matches.value).toBe(false);
		expect(media.matchMedia).toHaveBeenCalledWith('(min-width: 1024px)');
		scope.stop();
	});

	it('updates the ref when the viewport crosses the breakpoint', () => {
		const media = installMatchMedia(false);
		const scope = effectScope();
		const matches = scope.run(() => useMediaQuery('(min-width: 1024px)'))!;

		media.emit(true);
		expect(matches.value).toBe(true);

		media.emit(false);
		expect(matches.value).toBe(false);

		scope.stop();
	});

	it('removes its listener when the owning scope is disposed', () => {
		const media = installMatchMedia(true);
		const scope = effectScope();
		const matches = scope.run(() => useMediaQuery('(min-width: 1024px)'))!;
		expect(media.listenerCount).toBe(1);

		scope.stop();

		expect(media.listenerCount).toBe(0);
		expect(media.mql.removeEventListener).toHaveBeenCalledWith(
			'change',
			media.mql.addEventListener.mock.calls[0]![1]
		);
		// A leaked listener would still be writing into this ref.
		media.emit(false);
		expect(matches.value).toBe(true);
	});

	it('falls back to true where there is no matchMedia to ask', () => {
		// Unit tests and any non-browser runtime: a viewport gate must never hide
		// content when there is no viewport to measure.
		Reflect.deleteProperty(window, 'matchMedia');
		const scope = effectScope();

		const matches = scope.run(() => useMediaQuery('(min-width: 1024px)'))!;

		expect(matches.value).toBe(true);
		scope.stop();
	});
});

describe('useDataTableViewport', () => {
	it('gates on md, below which the tables render as card lists', () => {
		const media = installMatchMedia(false);
		const scope = effectScope();

		const fits = scope.run(() => useDataTableViewport())!;

		expect(media.matchMedia).toHaveBeenCalledWith('(min-width: 768px)');
		expect(fits.value).toBe(false);
		scope.stop();
	});
});

describe('useEmailBuilderViewport', () => {
	it('gates on the md breakpoint the canvas plus its two panels need', () => {
		const media = installMatchMedia(true);
		const scope = effectScope();

		const fits = scope.run(() => useEmailBuilderViewport())!;

		expect(media.matchMedia).toHaveBeenCalledWith('(min-width: 768px)');
		expect(fits.value).toBe(true);
		scope.stop();
	});
});
