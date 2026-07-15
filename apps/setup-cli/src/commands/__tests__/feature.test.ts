import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { applyAndPersist } = vi.hoisted(() => ({ applyAndPersist: vi.fn() }));

vi.mock('../../lib/flagState', () => ({ applyAndPersist }));

import { runFeature } from '../feature';

describe('runFeature', () => {
	beforeEach(() => {
		applyAndPersist.mockReset();
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});
	afterEach(() => vi.restoreAllMocks());

	it.each(['toString', 'constructor', '__proto__'])(
		'rejects inherited object key %s without persisting state',
		async (key) => {
			await expect(
				runFeature({ owlatDir: '/tmp/owlat-test', positional: [key, 'on'] })
			).resolves.toBe(1);
			expect(applyAndPersist).not.toHaveBeenCalled();
			expect(console.error).toHaveBeenCalledWith(`Unknown feature flag: ${key}`);
		}
	);
});
