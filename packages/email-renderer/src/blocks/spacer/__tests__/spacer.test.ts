import { describe, it, expect } from 'vitest';
import { spacerModule } from '../index';
import type { SpacerBlockContent } from '@owlat/shared';
import type { RenderArgs, RenderContext } from '../../_module';

const ctx = {} as RenderContext;
const args = (content: SpacerBlockContent): RenderArgs<'spacer'> => ({
	block: { id: 'b1', type: 'spacer', content },
	content,
	ctx,
	width: 600,
	placement: 'root',
	walk: () => '',
});

describe('spacerModule.html', () => {
	it('renders spacer with correct height', () => {
		const result = spacerModule.html(args({ height: 40 }));
		expect(result).toContain('height:40px');
		expect(result).toContain('line-height:40px');
		expect(result).toContain('font-size:1px');
		expect(result).toContain('&nbsp;');
	});

	it('includes mso-height-rule:exactly', () => {
		const result = spacerModule.html(args({ height: 20 }));
		expect(result).toContain('mso-height-rule:exactly');
	});

	it('renders identically at column placement (no extra wrapping)', () => {
		const rootResult = spacerModule.html(args({ height: 40 }));
		const colResult = spacerModule.html({ ...args({ height: 40 }), placement: 'column' });
		expect(rootResult).toBe(colResult);
	});
});

describe('spacerModule.plaintext', () => {
	it('returns empty string (visual block only)', () => {
		expect(spacerModule.plaintext!({ block: {} as never, content: {} as never, walk: () => '' })).toBe('');
	});
});

describe('spacerModule.amp', () => {
	it('emits a height-styled div', () => {
		const result = spacerModule.amp!({ block: { id: 'b', type: 'spacer', content: { height: 25 } }, content: { height: 25 }, walk: () => '' });
		expect(result).toContain('height:25px');
	});
});
