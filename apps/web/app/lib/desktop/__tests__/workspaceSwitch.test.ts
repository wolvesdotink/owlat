import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clearSwitchFlag,
	CROSSFADE_SLOW_MS,
	hideSwitchSkeleton,
	readSwitchFlag,
	showSwitchSkeleton,
	SWITCH_FLAG_KEY,
	SWITCH_FLAG_TTL_MS,
	writeSwitchFlag,
	type WorkspaceSwitchFlag,
} from '../workspaceSwitch';

const SKELETON_SELECTOR = '[data-owlat-switch-skeleton]';

/** Stub prefers-reduced-motion for the duration of a test. */
function stubReducedMotion(reduce: boolean): void {
	vi.stubGlobal(
		'matchMedia',
		(query: string) =>
			({
				matches: query.includes('reduce') ? reduce : false,
				media: query,
				addEventListener: () => {},
				removeEventListener: () => {},
			}) as unknown as MediaQueryList
	);
}

/** Minimal in-memory Storage stand-in (deterministic, no jsdom coupling). */
function fakeStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
		key: (i: number) => Array.from(map.keys())[i] ?? null,
		removeItem: (k: string) => void map.delete(k),
		setItem: (k: string, v: string) => void map.set(k, v),
	} satisfies Storage;
}

const flag: WorkspaceSwitchFlag = { accent: '#c4785a', label: 'Acme', at: 1000 };

describe('workspace switch flag lifecycle', () => {
	it('round-trips a fresh flag: set -> read -> consume', () => {
		const storage = fakeStorage();
		writeSwitchFlag(storage, flag);
		// Present + fresh at the same instant it was written.
		expect(readSwitchFlag(storage, flag.at)).toEqual(flag);
		// Consumed: subsequent reads see nothing.
		clearSwitchFlag(storage);
		expect(storage.getItem(SWITCH_FLAG_KEY)).toBeNull();
		expect(readSwitchFlag(storage, flag.at)).toBeNull();
	});

	it('returns null when no flag was ever written', () => {
		expect(readSwitchFlag(fakeStorage(), 5000)).toBeNull();
	});

	it('honors the TTL boundary but discards a stale flag (timeout fallback)', () => {
		const storage = fakeStorage();
		writeSwitchFlag(storage, flag);
		// Exactly at the TTL edge is still valid.
		expect(readSwitchFlag(storage, flag.at + SWITCH_FLAG_TTL_MS)).toEqual(flag);
		// One ms past the TTL — the reload evidently stalled; discard.
		expect(readSwitchFlag(storage, flag.at + SWITCH_FLAG_TTL_MS + 1)).toBeNull();
	});

	it('discards a flag whose timestamp is in the future (clock skew guard)', () => {
		const storage = fakeStorage();
		writeSwitchFlag(storage, flag);
		expect(readSwitchFlag(storage, flag.at - 1)).toBeNull();
	});

	it('discards malformed / non-JSON payloads without throwing', () => {
		const storage = fakeStorage();
		storage.setItem(SWITCH_FLAG_KEY, 'not-json{');
		expect(readSwitchFlag(storage, flag.at)).toBeNull();
		storage.setItem(SWITCH_FLAG_KEY, JSON.stringify({ accent: 1, label: 2 }));
		expect(readSwitchFlag(storage, flag.at)).toBeNull();
	});

	it('rejects a flag whose accent is not a #rrggbb hex colour', () => {
		const storage = fakeStorage();
		// A corrupted accent that would otherwise be interpolated into the
		// skeleton's color-mix()/box-shadow style strings.
		storage.setItem(
			SWITCH_FLAG_KEY,
			JSON.stringify({ accent: 'red);--x', label: 'Acme', at: flag.at })
		);
		expect(readSwitchFlag(storage, flag.at)).toBeNull();
		// Shorthand / malformed hex is rejected too.
		storage.setItem(
			SWITCH_FLAG_KEY,
			JSON.stringify({ accent: '#fff', label: 'Acme', at: flag.at })
		);
		expect(readSwitchFlag(storage, flag.at)).toBeNull();
	});
});

describe('switch skeleton DOM', () => {
	afterEach(() => {
		document.querySelectorAll('[data-owlat-switch-skeleton]').forEach((el) => el.remove());
	});

	it('mounts a single skeleton and is idempotent', () => {
		const first = showSwitchSkeleton('#c4785a', 'Acme');
		const second = showSwitchSkeleton('#c4785a', 'Acme');
		expect(first).toBe(second);
		expect(document.querySelectorAll('[data-owlat-switch-skeleton]')).toHaveLength(1);
		expect(first.textContent).toContain('Acme');
	});

	it('hideSwitchSkeleton is safe to call with no skeleton present', () => {
		expect(() => hideSwitchSkeleton()).not.toThrow();
	});
});

describe('hideSwitchSkeleton removal paths', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		document.querySelectorAll(SKELETON_SELECTOR).forEach((el) => el.remove());
	});

	it('cuts immediately under reduced motion', () => {
		stubReducedMotion(true);
		const node = showSwitchSkeleton('#c4785a', 'Acme');
		hideSwitchSkeleton(node);
		expect(document.querySelector(SKELETON_SELECTOR)).toBeNull();
	});

	it('removes via the timeout fallback when transitionend never fires', () => {
		vi.useFakeTimers();
		stubReducedMotion(false);
		const node = showSwitchSkeleton('#c4785a', 'Acme');
		hideSwitchSkeleton(node);
		// Fade started but the node is still mounted until the fallback elapses.
		expect(node.style.opacity).toBe('0');
		expect(document.querySelector(SKELETON_SELECTOR)).toBe(node);
		// happy-dom can't resolve --motion-slow, so the fallback uses the constant.
		vi.advanceTimersByTime(CROSSFADE_SLOW_MS + 20);
		expect(document.querySelector(SKELETON_SELECTOR)).toBeNull();
	});

	it('marks the node leaving so a second call is a no-op', () => {
		vi.useFakeTimers();
		stubReducedMotion(false);
		const node = showSwitchSkeleton('#c4785a', 'Acme');
		hideSwitchSkeleton(node);
		expect(node.dataset['leaving']).toBe('1');
		// A concurrent second call must not schedule another teardown or throw.
		expect(() => hideSwitchSkeleton(node)).not.toThrow();
		vi.advanceTimersByTime(CROSSFADE_SLOW_MS + 20);
		expect(document.querySelector(SKELETON_SELECTOR)).toBeNull();
	});
});
