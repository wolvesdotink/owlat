import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BLOCK_MARGIN,
	DEFAULT_BLOCK_PADDING,
	DEFAULT_EMAIL_BASE_WIDTH,
	DEFAULT_EMAIL_THEME,
} from '../emailDefaults';

// The renderer, the builder canvas and the web settings page all read these.
// A change here changes every rendered email, so the values are pinned: update
// this test only together with the renderer goldens.
describe('emailDefaults', () => {
	it('pins the theme the renderer fills in when a caller leaves it unset', () => {
		expect({
			primaryColor: DEFAULT_EMAIL_THEME.primaryColor,
			fontFamily: DEFAULT_EMAIL_THEME.fontFamily,
			backgroundColor: DEFAULT_EMAIL_THEME.backgroundColor,
			darkModeBackgroundColor: DEFAULT_EMAIL_THEME.darkModeBackgroundColor,
			darkModeTextColor: DEFAULT_EMAIL_THEME.darkModeTextColor,
			darkModeLinkColor: DEFAULT_EMAIL_THEME.darkModeLinkColor,
		}).toEqual({
			primaryColor: '#c4785a',
			fontFamily: 'Arial, sans-serif',
			backgroundColor: '#ffffff',
			darkModeBackgroundColor: '#121212',
			darkModeTextColor: '#e4e4e7',
			darkModeLinkColor: '#93c5fd',
		});
	});

	it('uses the shared base width as the theme width', () => {
		expect(DEFAULT_EMAIL_BASE_WIDTH).toBe(600);
		expect(DEFAULT_EMAIL_THEME.baseWidth).toBe(DEFAULT_EMAIL_BASE_WIDTH);
	});

	it('populates every theme field so builder components get a complete theme', () => {
		for (const [key, value] of Object.entries(DEFAULT_EMAIL_THEME)) {
			expect(value, key).not.toBeUndefined();
		}
	});

	it('pins the block box defaults', () => {
		expect(DEFAULT_BLOCK_PADDING).toEqual({
			paddingTop: 16,
			paddingRight: 24,
			paddingBottom: 16,
			paddingLeft: 24,
			paddingLinked: false,
		});
		expect(DEFAULT_BLOCK_MARGIN).toEqual({
			marginTop: 0,
			marginRight: 0,
			marginBottom: 0,
			marginLeft: 0,
		});
	});
});
