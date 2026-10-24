/**
 * The shared visibility switch behind every looping decoration (skeleton
 * shimmer, indeterminate progress sweep, presence halo).
 *
 * The property under test is the custom property the CSS reads,
 * `--ui-animation-state`: `running` only while the element intersects the
 * viewport, the tab is visible and reduced motion is off. The browser APIs are
 * replaced with controlled fakes so each transition is driven by hand: there is
 * no real layout, clock or media query in happy-dom to wait on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANIMATION_STATE_PROPERTY, observeVisibleAnimation } from '../visibleAnimation';
import { REDUCED_MOTION_QUERY, setAppReducedMotion } from '../../composables/useReducedMotion';
import {
	FakeIntersectionObserver,
	installFakeIntersectionObserver,
} from '../../__tests__/fakeIntersectionObserver';

function installReducedMotion(initial: boolean) {
	const listeners = new Set<() => void>();
	const state = { matches: initial };
	const matchMedia = vi.fn((query: string) => ({
		get matches() {
			return query === REDUCED_MOTION_QUERY && state.matches;
		},
		media: query,
		addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
		removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
	}));
	window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
	return {
		listeners,
		set(value: boolean) {
			state.matches = value;
			for (const listener of listeners) listener();
		},
	};
}

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(value: DocumentVisibilityState): void {
	visibility = value;
	document.dispatchEvent(new Event('visibilitychange'));
}

const stateOf = (element: HTMLElement) => element.style.getPropertyValue(ANIMATION_STATE_PROPERTY);

const elements: HTMLElement[] = [];
function element(): HTMLElement {
	const el = document.createElement('div');
	document.body.appendChild(el);
	elements.push(el);
	return el;
}

const releases: Array<() => void> = [];
function register(el: HTMLElement): () => void {
	const release = observeVisibleAnimation(el);
	releases.push(release);
	return release;
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
	installFakeIntersectionObserver();
	visibility = 'visible';
	vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
	installReducedMotion(false);
});

afterEach(() => {
	// Every test leaves the module with no registrations, so the next one starts
	// from a torn-down controller.
	for (const release of releases.splice(0)) release();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.matchMedia = originalMatchMedia;
	setAppReducedMotion(false);
	for (const el of elements.splice(0)) el.remove();
});

describe('observeVisibleAnimation', () => {
	it('watches every element through one shared observer', () => {
		const a = element();
		const b = element();
		const c = element();
		register(a);
		register(b);
		register(c);
		expect(FakeIntersectionObserver.instances).toHaveLength(1);
		expect([...FakeIntersectionObserver.instances[0]!.observed]).toEqual([a, b, c]);
	});

	it('holds an element paused until the observer reports it on screen', () => {
		const el = element();
		register(el);
		expect(stateOf(el)).toBe('paused');

		const observer = FakeIntersectionObserver.instances[0]!;
		observer.report(el, true);
		expect(stateOf(el)).toBe('running');

		observer.report(el, false);
		expect(stateOf(el)).toBe('paused');
	});

	it('pauses each element on its own visibility, not its neighbours', () => {
		const onScreen = element();
		const belowFold = element();
		register(onScreen);
		register(belowFold);
		const observer = FakeIntersectionObserver.instances[0]!;
		observer.report(onScreen, true);
		observer.report(belowFold, false);
		expect(stateOf(onScreen)).toBe('running');
		expect(stateOf(belowFold)).toBe('paused');
	});

	it('pauses everything while the tab is hidden and resumes what is on screen', () => {
		const onScreen = element();
		const offScreen = element();
		register(onScreen);
		register(offScreen);
		const observer = FakeIntersectionObserver.instances[0]!;
		observer.report(onScreen, true);

		setVisibility('hidden');
		expect(stateOf(onScreen)).toBe('paused');
		expect(stateOf(offScreen)).toBe('paused');

		setVisibility('visible');
		expect(stateOf(onScreen)).toBe('running');
		expect(stateOf(offScreen)).toBe('paused');
	});

	it('stops under reduced motion, including when it is turned on mid-session', () => {
		const media = installReducedMotion(false);
		const el = element();
		register(el);
		FakeIntersectionObserver.instances[0]!.report(el, true);
		expect(stateOf(el)).toBe('running');

		media.set(true);
		expect(stateOf(el)).toBe('paused');

		media.set(false);
		expect(stateOf(el)).toBe('running');
	});

	it("stops under the app's own Reduce motion switch, and runs again when it goes off", () => {
		const el = element();
		register(el);
		FakeIntersectionObserver.instances[0]!.report(el, true);
		expect(stateOf(el)).toBe('running');

		setAppReducedMotion(true);
		expect(stateOf(el)).toBe('paused');

		setAppReducedMotion(false);
		expect(stateOf(el)).toBe('running');
	});

	it('stops listening to the app switch once nothing is registered', () => {
		const el = element();
		register(el)();
		setAppReducedMotion(true);
		setAppReducedMotion(false);
		// Released: the switch no longer writes into it.
		expect(stateOf(el)).toBe('paused');
	});

	it('never runs an element registered while reduced motion is already on', () => {
		installReducedMotion(true);
		const el = element();
		register(el);
		FakeIntersectionObserver.instances[0]!.report(el, true);
		expect(stateOf(el)).toBe('paused');
	});

	it('unobserves and pauses an element on release', () => {
		const a = element();
		const b = element();
		const releaseA = register(a);
		register(b);
		const observer = FakeIntersectionObserver.instances[0]!;
		observer.report(a, true);

		releaseA();
		expect(observer.observed.has(a)).toBe(false);
		expect(stateOf(a)).toBe('paused');
		// A late entry for the released element must not restart it.
		observer.report(a, true);
		expect(stateOf(a)).toBe('paused');
		expect(observer.disconnected).toBe(false);
	});

	it('tears the observer and both listeners down with the last registration', () => {
		const media = installReducedMotion(false);
		const removeListener = vi.spyOn(document, 'removeEventListener');
		const release = register(element());
		const observer = FakeIntersectionObserver.instances[0]!;
		expect(media.listeners.size).toBe(1);

		release();
		expect(observer.disconnected).toBe(true);
		expect(media.listeners.size).toBe(0);
		expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
	});

	it('ignores a stale callback from an observer that was already torn down', () => {
		const first = element();
		register(first)();
		const stale = FakeIntersectionObserver.instances[0]!;

		const next = element();
		register(next);
		expect(FakeIntersectionObserver.instances).toHaveLength(2);

		stale.report(next, true);
		expect(stateOf(next)).toBe('paused');
		FakeIntersectionObserver.instances[1]!.report(next, true);
		expect(stateOf(next)).toBe('running');
	});

	it('treats a release as idempotent and a re-registration as a fresh owner', () => {
		const el = element();
		const releaseOld = observeVisibleAnimation(el);
		const releaseNew = register(el);
		const observer = FakeIntersectionObserver.instances[0]!;
		observer.report(el, true);

		releaseOld();
		releaseOld();
		// The newer registration still owns the element and keeps it observed.
		expect(observer.observed.has(el)).toBe(true);
		expect(stateOf(el)).toBe('running');

		releaseNew();
		expect(observer.observed.has(el)).toBe(false);
	});

	it('keeps the loop on screen without IntersectionObserver, still honouring the tab', () => {
		vi.stubGlobal('IntersectionObserver', undefined);
		const el = element();
		register(el);
		expect(stateOf(el)).toBe('running');

		setVisibility('hidden');
		expect(stateOf(el)).toBe('paused');
	});
});
