import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BLOCK_MARGIN,
	DEFAULT_BLOCK_PADDING,
	DEFAULT_EMAIL_BASE_WIDTH,
	DEFAULT_EMAIL_THEME,
} from '@owlat/shared/emailDefaults';
import { DEFAULT_BASE_WIDTH, DEFAULT_THEME } from '../renderer';
import { getSectionPadding } from '../helpers/padding';
import { moduleFor } from '../blocks/_registry';

describe('renderer defaults come from @owlat/shared/emailDefaults', () => {
	it('fills in exactly the six theme keys it always has, with the shared values', () => {
		// More keys would reach every block's render context and change the HTML.
		expect(Object.keys(DEFAULT_THEME)).toEqual([
			'primaryColor',
			'fontFamily',
			'backgroundColor',
			'darkModeBackgroundColor',
			'darkModeTextColor',
			'darkModeLinkColor',
		]);
		for (const [key, value] of Object.entries(DEFAULT_THEME)) {
			expect(value, key).toBe(DEFAULT_EMAIL_THEME[key as keyof typeof DEFAULT_THEME]);
		}
	});

	it('re-exports the shared base width', () => {
		expect(DEFAULT_BASE_WIDTH).toBe(DEFAULT_EMAIL_BASE_WIDTH);
	});

	it('pads a block with no padding or margin by the shared block defaults', () => {
		const p = DEFAULT_BLOCK_PADDING;
		const m = DEFAULT_BLOCK_MARGIN;
		expect(getSectionPadding({} as never)).toBe(
			`${p.paddingTop + m.marginTop}px ${p.paddingRight + m.marginRight}px ` +
				`${p.paddingBottom + m.marginBottom}px ${p.paddingLeft + m.marginLeft}px`
		);
	});

	it('creates a container with the shared block padding and margin', () => {
		const content = moduleFor('container')?.createDefault?.(DEFAULT_EMAIL_THEME) as Record<
			string,
			unknown
		>;
		expect(content).toMatchObject({ ...DEFAULT_BLOCK_PADDING, ...DEFAULT_BLOCK_MARGIN });
	});
});
