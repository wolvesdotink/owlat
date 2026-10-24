import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateUndoToken } from '../undoToken';

describe('generateUndoToken', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('stamps the hold time and a random suffix', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		expect(generateUndoToken(1_000)).toBe(
			`und_${(1_000).toString(36)}_${(0.5).toString(36).slice(2, 10)}`
		);
	});

	it('gives two holds at the same instant different tokens', () => {
		vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
		expect(generateUndoToken(1_000)).not.toBe(generateUndoToken(1_000));
	});
});
