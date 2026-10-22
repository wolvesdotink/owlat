import { beforeEach, describe, expect, it, vi } from 'vitest';

// The state is module-level (one Zen for the whole app), so each case loads a
// fresh copy of the module.
async function load() {
	vi.resetModules();
	return (await import('../useZenMode')).useZenMode;
}

beforeEach(() => sessionStorage.clear());

describe('useZenMode', () => {
	it('is one app-wide flag', async () => {
		const useZenMode = await load();
		const a = useZenMode();
		const b = useZenMode();
		a.enterZen();
		expect(b.isZen.value).toBe(true);
		b.toggleZen();
		expect(a.isZen.value).toBe(false);
	});

	it('survives a reload in the same tab, and leaving clears it', async () => {
		let useZenMode = await load();
		useZenMode().enterZen();
		useZenMode = await load();
		expect(useZenMode().isZen.value).toBe(true);
		useZenMode().exitZen();
		useZenMode = await load();
		expect(useZenMode().isZen.value).toBe(false);
	});
});
