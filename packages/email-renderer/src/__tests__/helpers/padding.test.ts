import { describe, it, expect } from 'vitest';
import { getSectionPadding, getSectionBackground, getSectionBorder, getMarginOnlyPadding } from '../../helpers/padding';
import { buttonModule } from '../../blocks/button';
import { heroModule } from '../../blocks/hero';
import type { EditorBlock, ButtonBlockContent, HeroBlockContent } from '@owlat/shared';

describe('getSectionPadding', () => {
	it('returns default padding when no values set', () => {
		const result = getSectionPadding({} as EditorBlock['content']);
		expect(result).toBe('16px 24px 16px 24px');
	});

	it('combines padding and margin', () => {
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
		expect(result).toBe('15px 25px 15px 25px');
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
		expect(buttonModule.layout!(content)).toEqual({ background: '#00ff00' });
	});

	it('returns empty layout when blockBackgroundColor is unset', () => {
		const content = {} as unknown as ButtonBlockContent;
		expect(buttonModule.layout!(content)).toEqual({});
	});

	it('skips the transparent sentinel', () => {
		const content = { blockBackgroundColor: 'transparent' } as unknown as ButtonBlockContent;
		expect(buttonModule.layout!(content)).toEqual({});
	});
});

describe('heroModule.layout', () => {
	it('returns sectionMode: outer-only so the bg image flows to the table edges', () => {
		const content = {} as unknown as HeroBlockContent;
		expect(heroModule.layout!(content)).toEqual({ sectionMode: 'outer-only' });
	});
});

describe('getMarginOnlyPadding', () => {
	it('returns margin-only padding string (used by hero sections)', () => {
		const content = {
			marginTop: 5, marginRight: 10, marginBottom: 5, marginLeft: 10,
			paddingTop: 99, paddingRight: 99, paddingBottom: 99, paddingLeft: 99,
		} as unknown as EditorBlock['content'];
		expect(getMarginOnlyPadding(content)).toBe('5px 10px 5px 10px');
	});

	it('defaults to zero when margins are unset', () => {
		expect(getMarginOnlyPadding({} as EditorBlock['content'])).toBe('0px 0px 0px 0px');
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
