import { describe, it, expect } from 'vitest';
import { parseMimeTree, parseMimeTreeWithBounds, MAX_MIME_PARTS } from '../parse/body';

/**
 * `parseMimeTreeWithBounds` reports when the walker's depth or part bound left
 * content out of the tree, so a caller that vouches for the whole message can
 * tell an incomplete leaf list from a complete one (GHSA-72gq-2gg3-2vqq).
 */

function flat(count: number): string {
	const lines = ['Content-Type: multipart/mixed; boundary="F"', ''];
	for (let i = 0; i < count; i++) lines.push('--F', 'Content-Type: text/plain', '', `p${i}`);
	lines.push('--F--', '');
	return lines.join('\r\n');
}

function nested(levels: number): string {
	const open: string[] = [];
	const close: string[] = [];
	for (let i = 0; i < levels; i++) {
		open.push(`Content-Type: multipart/mixed; boundary="n${i}"`, '', `--n${i}`);
		close.unshift(`--n${i}--`);
	}
	return [...open, 'Content-Type: text/plain', '', 'leaf', ...close].join('\r\n');
}

describe('parseMimeTreeWithBounds', () => {
	it('is not truncated when every part fits the budget', () => {
		expect(parseMimeTreeWithBounds(flat(MAX_MIME_PARTS)).truncated).toBe(false);
		expect(parseMimeTreeWithBounds('Subject: x\r\n\r\nbody').truncated).toBe(false);
	});

	it('is truncated when parts remain after the part budget is spent', () => {
		const { root, truncated } = parseMimeTreeWithBounds(flat(MAX_MIME_PARTS + 1));
		expect(truncated).toBe(true);
		expect(root.children).toHaveLength(MAX_MIME_PARTS);
	});

	it('is truncated when a multipart container sits at the depth bound', () => {
		expect(parseMimeTreeWithBounds(nested(100)).truncated).toBe(false);
		expect(parseMimeTreeWithBounds(nested(101)).truncated).toBe(true);
	});

	it('builds the same tree as parseMimeTree', () => {
		const raw = flat(MAX_MIME_PARTS + 5);
		expect(parseMimeTreeWithBounds(raw).root).toEqual(parseMimeTree(raw));
	});
});
