import { describe, it, expect } from 'vitest';
import {
	getSectionPadding,
	getSectionBackground,
	getSectionBorder,
	getSectionMargin,
	getNestedItemPadding,
} from '../../helpers/padding';
import { buttonModule } from '../../blocks/button';
import { heroModule } from '../../blocks/hero';
import type { EditorBlock, ButtonBlockContent, HeroBlockContent } from '@owlat/shared';

describe('getSectionPadding', () => {
	it('returns default padding when no values set', () => {
		const result = getSectionPadding({} as EditorBlock['content']);
		expect(result).toBe('16px 24px 16px 24px');
	});

	it('leaves the margin out of the padding', () => {
		const content = {
			paddingTop: 10,
			paddingRight: 20,
			paddingBottom: 10,
			paddingLeft: 20,
			marginTop: 5,
			marginRight: 5,
			marginBottom: 5,
			marginLeft: 5,
		};
		const result = getSectionPadding(content as unknown as EditorBlock['content']);
		expect(result).toBe('10px 20px 10px 20px');
	});
});

describe('getSectionBackground', () => {
	it('returns content.backgroundColor', () => {
		const content = { backgroundColor: '#ff0000' } as unknown as EditorBlock['content'];
		expect(getSectionBackground(content)).toBe('#ff0000');
	});

	it('returns empty string for transparent', () => {
		const content = { backgroundColor: 'transparent' } as unknown as EditorBlock['content'];
		expect(getSectionBackground(content)).toBe('');
	});

	it('does not consult per-block override fields — those are owned by BlockModule.layout()', () => {
		// `blockBackgroundColor` is the section-bg field on a button block, but
		// the Walker reads it via `buttonModule.layout()`, not this helper.
		const content = { blockBackgroundColor: '#00ff00' } as unknown as EditorBlock['content'];
		expect(getSectionBackground(content)).toBe('');
	});
});

describe('buttonModule.layout', () => {
	it('returns blockBackgroundColor as the section background', () => {
		const content = { blockBackgroundColor: '#00ff00' } as unknown as ButtonBlockContent;
		expect(buttonModule.layout!(content)).toEqual({
			background: '#00ff00',
			gradient: '',
			borderRadius: 0,
		});
	});

	it('explicitly suppresses every section default when blockBackgroundColor is unset', () => {
		// An omitted field falls through to the Walker's content-derived default,
		// and for a button that default IS the button's own fill/radius — the
		// full-width wrapper would render as one giant button-colored band.
		const content = {} as unknown as ButtonBlockContent;
		expect(buttonModule.layout!(content)).toEqual({
			background: '',
			gradient: '',
			borderRadius: 0,
		});
	});

	it('skips the transparent sentinel', () => {
		const content = { blockBackgroundColor: 'transparent' } as unknown as ButtonBlockContent;
		expect(buttonModule.layout!(content)).toEqual({
			background: '',
			gradient: '',
			borderRadius: 0,
		});
	});
});

describe('heroModule.layout', () => {
	it('returns sectionMode: outer-only so the bg image flows to the table edges', () => {
		const content = {} as unknown as HeroBlockContent;
		expect(heroModule.layout!(content)).toEqual({ sectionMode: 'outer-only' });
	});
});

describe('getSectionMargin', () => {
	it('returns the margin alone', () => {
		const content = {
			marginTop: 5,
			marginRight: 10,
			marginBottom: 5,
			marginLeft: 10,
			paddingTop: 99,
			paddingRight: 99,
			paddingBottom: 99,
			paddingLeft: 99,
		} as unknown as EditorBlock['content'];
		expect(getSectionMargin(content)).toBe('5px 10px 5px 10px');
	});

	it('returns null when every margin is zero or unset', () => {
		expect(getSectionMargin({} as EditorBlock['content'])).toBeNull();
		expect(getSectionMargin({ marginTop: 0 } as EditorBlock['content'])).toBeNull();
	});
});

describe('getNestedItemPadding', () => {
	const pad = (content: Record<string, unknown>) =>
		getNestedItemPadding(content as unknown as EditorBlock['content']);

	it('keeps 8px 0 when the item sets no padding', () => {
		expect(pad({})).toBe('8px 0');
	});

	it('keeps 8px 0 for the padding sets the editor writes by default', () => {
		expect(pad({ paddingTop: 16, paddingRight: 0, paddingBottom: 16, paddingLeft: 0 })).toBe(
			'8px 0'
		);
		expect(pad({ paddingTop: 16, paddingRight: 24, paddingBottom: 16, paddingLeft: 24 })).toBe(
			'8px 0'
		);
	});

	it('applies any other padding, filling unset sides from 8px 0', () => {
		expect(pad({ paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 })).toBe(
			'0px 0px 0px 0px'
		);
		expect(pad({ paddingTop: 16, paddingRight: 0, paddingBottom: 4, paddingLeft: 0 })).toBe(
			'16px 0px 4px 0px'
		);
		expect(pad({ paddingLeft: 12 })).toBe('8px 0px 8px 12px');
	});
});

describe('getSectionBorder', () => {
	it('returns default border (no border)', () => {
		const block = {
			type: 'text',
			content: {},
		} as unknown as EditorBlock;
		const result = getSectionBorder(block);
		expect(result).toEqual({ width: 0, style: 'none', color: '#000000' });
	});

	it('returns custom border values', () => {
		const block = {
			type: 'text',
			content: {
				borderWidth: 2,
				borderStyle: 'solid',
				borderColor: '#333',
			},
		} as unknown as EditorBlock;
		const result = getSectionBorder(block);
		expect(result).toEqual({ width: 2, style: 'solid', color: '#333' });
	});
});
