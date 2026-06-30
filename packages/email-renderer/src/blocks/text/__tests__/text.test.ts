import { describe, it, expect } from 'vitest';
import { textModule } from '../index';
import type { TextBlockContent } from '@owlat/shared';
import type { RenderArgs, RenderContext } from '../../_module';

const ctx = { linkTransform: undefined } as RenderContext;
const args = (content: TextBlockContent, placement: 'root' | 'column' = 'root'): RenderArgs<'text'> => ({
	block: { id: 'b1', type: 'text', content },
	content,
	ctx,
	width: 600,
	placement,
	walk: () => '',
});

describe('textModule.html (root)', () => {
	it('renders text with correct styles', () => {
		const content: TextBlockContent = { html: '<p>Hello World</p>', blockType: 'paragraph', fontSize: 16, textColor: '#333333' };
		const result = textModule.html(args(content));
		expect(result).toContain('font-size:16px');
		expect(result).toContain('color:#333333');
		expect(result).toContain('line-height:1.5');
		expect(result).toContain('<p>Hello World</p>');
	});

	it('includes text-align when not left', () => {
		const result = textModule.html(args({ html: '<p>Centered</p>', blockType: 'paragraph', fontSize: 14, textColor: '#000', textAlign: 'center' }));
		expect(result).toContain('text-align:center');
	});

	it('omits text-align for left alignment at root', () => {
		const result = textModule.html(args({ html: '<p>Left</p>', blockType: 'paragraph', fontSize: 14, textColor: '#000', textAlign: 'left' }));
		expect(result).not.toContain('text-align');
	});

	it('uses custom line height', () => {
		const result = textModule.html(args({ html: '<p>Text</p>', blockType: 'paragraph', fontSize: 14, textColor: '#000', lineHeight: 2 }));
		expect(result).toContain('line-height:2');
	});

	it('emits semantic heading tag for h1/h2/h3', () => {
		const result = textModule.html(args({ html: 'Heading', blockType: 'h2', fontSize: 24, textColor: '#000' }));
		expect(result).toContain('<h2');
		expect(result).toContain('margin:0');
	});
});

describe('textModule.html (column)', () => {
	it('fuses styles into the column-cell td', () => {
		const content: TextBlockContent = { html: '<span>x</span>', blockType: 'paragraph', fontSize: 14, textColor: '#000', textAlign: 'left' };
		const result = textModule.html(args(content, 'column'));
		// At column placement, text-align:left IS emitted (Outlook needs it explicit).
		expect(result).toContain('text-align:left');
		expect(result).toContain('padding:8px 0');
	});
});

describe('textModule.html — sanitization (stored XSS)', () => {
	// The text block's `html` is author-supplied and is emitted verbatim into
	// outbound email HTML AND the non-sandboxed in-app editor canvas. It must be
	// scrubbed at the render boundary just like the rawHtml block.

	it('strips <script> tags from text HTML (root)', () => {
		const content: TextBlockContent = { html: '<p>Hi</p><script>alert(1)</script>', blockType: 'paragraph', fontSize: 16, textColor: '#000' };
		const result = textModule.html(args(content));
		expect(result).not.toContain('<script>');
		expect(result).not.toContain('alert(1)');
		// Benign content survives.
		expect(result).toContain('<p>Hi</p>');
	});

	it('strips event-handler attributes like onerror from <img> (root)', () => {
		const content: TextBlockContent = { html: '<img src="x" onerror="alert(1)">', blockType: 'paragraph', fontSize: 16, textColor: '#000' };
		const result = textModule.html(args(content));
		expect(result).not.toContain('onerror');
		expect(result).not.toContain('alert(1)');
	});

	it('neutralizes javascript: URLs in anchor href (root)', () => {
		const content: TextBlockContent = { html: '<a href="javascript:alert(1)">x</a>', blockType: 'paragraph', fontSize: 16, textColor: '#000' };
		const result = textModule.html(args(content));
		expect(result).not.toContain('javascript:');
	});

	it('strips <iframe> from text HTML (root)', () => {
		const content: TextBlockContent = { html: '<iframe src="https://evil.example"></iframe>', blockType: 'paragraph', fontSize: 16, textColor: '#000' };
		const result = textModule.html(args(content));
		expect(result).not.toContain('<iframe');
	});

	it('strips event-handler attributes at column placement too', () => {
		const content: TextBlockContent = { html: '<img src="x" onerror="alert(1)">', blockType: 'paragraph', fontSize: 16, textColor: '#000' };
		const result = textModule.html(args(content, 'column'));
		expect(result).not.toContain('onerror');
		expect(result).not.toContain('alert(1)');
	});

	it('survives nested-concatenation script smuggling (parser, not regex)', () => {
		const content: TextBlockContent = { html: '<scr<script>ipt>alert(1)</scr</script>ipt>', blockType: 'paragraph', fontSize: 16, textColor: '#000' };
		const result = textModule.html(args(content));
		expect(result.toLowerCase()).not.toContain('<script');
	});

	it('preserves variable placeholders ({{firstName}}) and the variable-tag class', () => {
		const content: TextBlockContent = { html: '<span class="variable-tag" data-variable="firstName">{{firstName}}</span>', blockType: 'paragraph', fontSize: 16, textColor: '#000' };
		const result = textModule.html(args(content));
		// The {{...}} placeholder must survive so downstream personalize() works.
		expect(result).toContain('{{firstName}}');
		expect(result).toContain('variable-tag');
	});

	it('amp branch also strips scripts', () => {
		const content: TextBlockContent = { html: '<p>Hi</p><script>alert(1)</script>', blockType: 'paragraph', fontSize: 16, textColor: '#000' };
		const result = textModule.amp!({ block: { id: 'b1', type: 'text', content }, content, walk: () => '' });
		expect(result).not.toContain('<script>');
		expect(result).not.toContain('alert(1)');
	});
});
