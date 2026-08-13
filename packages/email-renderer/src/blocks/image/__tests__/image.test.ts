import { describe, it, expect } from 'vitest';
import { imageModule } from '../index';
import { validateBlocks } from '../../../validator';
import type { ImageBlockContent } from '@owlat/shared';
import type { RenderArgs, RenderContext } from '../../_module';

const ctx = { baseWidth: 600, linkTransform: undefined } as RenderContext;
const args = (
	content: ImageBlockContent,
	placement: 'root' | 'column' = 'root'
): RenderArgs<'image'> => ({
	block: { id: 'b1', type: 'image', content },
	content,
	ctx,
	width: 600,
	placement,
	walk: () => '',
});

describe('imageModule.html', () => {
	it('renders image with correct attributes', () => {
		const content: ImageBlockContent = {
			src: 'https://example.com/img.jpg',
			alt: 'Test image',
			width: 100,
			align: 'center',
		};
		const result = imageModule.html(args(content));
		expect(result).toContain('src="https://example.com/img.jpg"');
		expect(result).toContain('alt="Test image"');
		expect(result).toContain('width="600"');
		expect(result).toContain('align="center"');
	});

	it('includes border="0" on img tag', () => {
		const result = imageModule.html(
			args({ src: 'https://example.com/img.jpg', alt: '', width: 100, align: 'center' })
		);
		expect(result).toContain('border="0"');
		expect(result).toContain('border:0');
		expect(result).toContain('outline:none');
	});

	it('returns empty string when no src (via isEmpty)', () => {
		const content: ImageBlockContent = { src: '', alt: '', width: 100, align: 'center' };
		expect(imageModule.isEmpty!(content)).toBe(true);
		expect(imageModule.html(args(content))).toBe('');
	});

	it('wraps in link when linkUrl provided', () => {
		const result = imageModule.html(
			args({
				src: 'https://example.com/img.jpg',
				alt: 'Linked',
				width: 50,
				align: 'center',
				linkUrl: 'https://example.com',
			})
		);
		expect(result).toContain('href="https://example.com"');
		expect(result).toContain('<a ');
		expect(result).toContain('target="_blank"');
	});

	it('applies border radius', () => {
		const result = imageModule.html(
			args({
				src: 'https://example.com/img.jpg',
				alt: '',
				width: 100,
				align: 'center',
				borderRadius: 8,
			})
		);
		expect(result).toContain('border-radius:8px');
	});

	it('emits a padding cell at column placement', () => {
		const result = imageModule.html(
			args({ src: 'https://example.com/img.jpg', alt: '', width: 100, align: 'center' }, 'column')
		);
		expect(result).toContain('padding:8px 0');
		expect(result).toContain('<img');
	});
});

describe('decorative images', () => {
	const decorative: ImageBlockContent = {
		src: 'https://example.com/ornament.png',
		alt: '',
		width: 100,
		align: 'center',
		decorative: true,
	};

	// The alignment table already carries role="presentation", so assert on the
	// <img> tags specifically.
	const presentationalImages = (html: string) =>
		(html.match(/<img[^>]*role="presentation"/g) ?? []).length;

	it('renders an intentional empty alt plus role="presentation"', () => {
		const result = imageModule.html(args(decorative));
		expect(result).toContain('alt=""');
		expect(presentationalImages(result)).toBe(1);
	});

	it('drops any leftover alt text and the link aria-label', () => {
		const result = imageModule.html(
			args({ ...decorative, alt: 'stale text', linkUrl: 'https://example.com' })
		);
		expect(result).not.toContain('stale text');
		expect(result).not.toContain('aria-label');
	});

	it('marks both variants of a dark-mode pair as presentational', () => {
		const result = imageModule.html(
			args({ ...decorative, darkSrc: 'https://example.com/ornament-dark.png' })
		);
		expect(presentationalImages(result)).toBe(2);
	});

	it('leaves non-decorative images without a presentation role', () => {
		const result = imageModule.html(args({ ...decorative, decorative: false, alt: 'A logo' }));
		expect(result).toContain('alt="A logo"');
		expect(presentationalImages(result)).toBe(0);
	});

	it('satisfies the missing-alt audit', () => {
		const result = validateBlocks([{ id: 'b1', type: 'image', content: decorative }], {
			accessibilityAudit: true,
		});
		expect(result.issues.some((i) => i.code === 'IMAGE_NO_ALT')).toBe(false);
	});

	it('still reports missing alt when the image is not decorative', () => {
		const content: ImageBlockContent = { ...decorative, decorative: false };
		const result = validateBlocks([{ id: 'b1', type: 'image', content }], {
			accessibilityAudit: true,
		});
		expect(result.issues.some((i) => i.code === 'IMAGE_NO_ALT')).toBe(true);
	});
});
