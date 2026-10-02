/**
 * The editors and the renderer must agree on the theme an organization gets,
 * so the composable builds it with the shared brand kit projection: the shared
 * defaults when nothing is configured, the kit's text colour, heading font and
 * web fonts once a kit is saved.
 */
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { DEFAULT_EMAIL_THEME } from '@owlat/shared/emailDefaults';
import { resolveBrandKitDesign } from '@owlat/shared/brandKit';
import { useEmailTheme } from '../useEmailTheme';

const kit = ref<unknown>(undefined);
vi.stubGlobal('useOrganizationQuery', () => ({ data: kit }));

const noLogos = { light: null, dark: null };

describe('useEmailTheme', () => {
	it('falls back to the shared defaults while nothing has loaded', () => {
		kit.value = undefined;
		const { emailTheme, brand } = useEmailTheme();
		expect(emailTheme.value).toEqual({
			primaryColor: DEFAULT_EMAIL_THEME.primaryColor,
			fontFamily: DEFAULT_EMAIL_THEME.fontFamily,
			backgroundColor: DEFAULT_EMAIL_THEME.backgroundColor,
			baseWidth: DEFAULT_EMAIL_THEME.baseWidth,
		});
		expect(brand.value).toBeUndefined();
	});

	it('keeps the four theme values alone until a brand kit is saved', () => {
		kit.value = {
			design: resolveBrandKitDesign(
				{ primaryColor: '#123456', fontFamily: 'Georgia, serif', backgroundColor: '' },
				undefined
			),
			logos: noLogos,
		};
		expect(useEmailTheme().emailTheme.value).toEqual({
			primaryColor: '#123456',
			fontFamily: 'Georgia, serif',
			backgroundColor: DEFAULT_EMAIL_THEME.backgroundColor,
			baseWidth: DEFAULT_EMAIL_THEME.baseWidth,
		});
	});

	it('carries the saved kit into the theme and hands the editor the brand', () => {
		const design = resolveBrandKitDesign(
			{
				primaryColor: '#0f766e',
				fontFamily: "'Inter', Arial, sans-serif",
				backgroundColor: '#fff',
			},
			{ textColor: '#111827', headingFontFamily: 'Georgia, serif' }
		);
		kit.value = { design, logos: noLogos };
		const { emailTheme, brand } = useEmailTheme();
		expect(emailTheme.value).toMatchObject({
			primaryColor: '#0f766e',
			bodyTextColor: '#111827',
			headingFontFamily: 'Georgia, serif',
			fontUrls: [expect.stringContaining('family=Inter')],
		});
		expect(brand.value).toEqual({ design, logos: noLogos });
	});
});
