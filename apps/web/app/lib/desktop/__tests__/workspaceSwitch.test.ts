import { afterEach, describe, expect, it } from 'vitest';
import {
	clearSwitchFlag,
	hideSwitchSkeleton,
	readSwitchFlag,
	showSwitchSkeleton,
	SWITCH_FLAG_KEY,
	SWITCH_FLAG_TTL_MS,
	writeSwitchFlag,
	type WorkspaceSwitchFlag,
} from '../workspaceSwitch';

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
