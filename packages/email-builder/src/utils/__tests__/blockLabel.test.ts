import { describe, expect, it } from 'vitest';
import type { EditorBlock } from '../../types';
import { blockContentExcerpt } from '../blockLabel';

const image = (src: string): EditorBlock =>
	({ id: 'img', type: 'image', content: { src } }) as unknown as EditorBlock;

describe('blockContentExcerpt — image file names', () => {
	it('reads the last path segment, without query or hash', () => {
		expect(blockContentExcerpt(image('https://cdn.example.com/a/hero-banner.png?w=600#x'))).toBe(
			'hero-banner.png'
		);
	});

	it('skips empty segments left by trailing slashes', () => {
		expect(blockContentExcerpt(image('https://cdn.example.com/assets/hero//'))).toBe('hero');
	});

	it('is empty for a URL with no path segment', () => {
		expect(blockContentExcerpt(image(''))).toBe('');
	});
});
