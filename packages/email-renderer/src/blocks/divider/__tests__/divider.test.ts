import { describe, it, expect } from 'vitest';
import { dividerModule } from '../index';
import type { DividerBlockContent } from '@owlat/shared';
import type { RenderContext, RenderArgs } from '../../_module';

const ctx = {} as RenderContext;
const baseArgs = (content: DividerBlockContent): RenderArgs<'divider'> => ({
	block: { id: 'b1', type: 'divider', content },
	content,
	ctx,
	width: 600,
	placement: 'root',
	walk: () => '',
});

describe('dividerModule.html', () => {
	it('renders divider with correct styles at root', () => {
		const content: DividerBlockContent = { color: '#cccccc', thickness: 1, width: 100, style: 'solid' };
		const result = dividerModule.html(baseArgs(content));
		expect(result).toContain('border-top:1px solid #cccccc');
		expect(result).toContain('width="100%"');
	});

	it('supports dashed style', () => {
		const content: DividerBlockContent = { color: '#000000', thickness: 2, width: 80, style: 'dashed' };
		const result = dividerModule.html(baseArgs(content));
		expect(result).toContain('border-top:2px dashed #000000');
		expect(result).toContain('width="80%"');
	});

	it('wraps in column-item padding cell at column placement', () => {
		const content: DividerBlockContent = { color: '#cccccc', thickness: 1, width: 100, style: 'solid' };
		const result = dividerModule.html({ ...baseArgs(content), placement: 'column' });
		expect(result).toContain('padding:8px 0');
		expect(result).toContain('border-top:1px solid #cccccc');
	});
});

describe('dividerModule.plaintext', () => {
	it('returns the divider rule', () => {
		expect(dividerModule.plaintext!({ block: {} as never, content: {} as never, walk: () => '' })).toBe('---');
	});
});

describe('dividerModule.amp', () => {
	it('emits an HR with thickness/style/color/width', () => {
		const content: DividerBlockContent = { color: '#cccccc', thickness: 1, width: 100, style: 'solid' };
		const result = dividerModule.amp!({ block: { id: 'b1', type: 'divider', content }, content, walk: () => '' });
		expect(result).toContain('border-top:1px solid #cccccc');
		expect(result).toContain('width:100%');
	});
});

describe('dividerModule.placements', () => {
	it('accepts root, column, container', () => {
		expect(dividerModule.placements).toEqual(['root', 'column', 'container']);
	});
});
