/**
 * The examples of the brand kit operations, spread into `OPERATION_EXAMPLES`
 * (`./examples.ts`), which says what every example must hold.
 */

import type { OperationExample } from './examples';
import type { ApiResponse, BrandKit, BrandKitInput } from './types';

const BRAND_KIT: BrandKit = {
	isConfigured: true,
	primaryColor: '#0f766e',
	secondaryColor: '#282d3a',
	textColor: '#374151',
	backgroundColor: '#ffffff',
	linkColor: '#0f766e',
	swatches: ['#f59e0b'],
	headingFontFamily: "'Montserrat', Arial, sans-serif",
	bodyFontFamily: "'Inter', Arial, sans-serif",
	buttonRadius: 6,
	buttonPaddingX: 24,
	buttonPaddingY: 12,
	baseWidth: 600,
	footerCompanyName: 'Example Shop GmbH',
	footerAddress: '1 Example Street\n12345 Example City',
	footerSocialLinks: [{ platform: 'github', url: 'https://github.com/example' }],
	logo: { url: 'https://files.owlat.example/logo.png', width: 160 },
	logoDark: null,
};

export const BRAND_KIT_EXAMPLES = {
	getBrandKit: {
		response: { data: BRAND_KIT } satisfies ApiResponse<BrandKit>,
	},
	updateBrandKit: {
		request: {
			primaryColor: '#0f766e',
			secondaryColor: '#282d3a',
			textColor: '#374151',
			backgroundColor: '#ffffff',
			linkColor: '#0f766e',
			swatches: ['#f59e0b'],
			headingFontFamily: "'Montserrat', Arial, sans-serif",
			bodyFontFamily: "'Inter', Arial, sans-serif",
			buttonRadius: 6,
			buttonPaddingX: 24,
			buttonPaddingY: 12,
			baseWidth: 600,
			footerCompanyName: 'Example Shop GmbH',
			footerAddress: '1 Example Street\n12345 Example City',
			footerSocialLinks: [{ platform: 'github', url: 'https://github.com/example' }],
		} satisfies Required<BrandKitInput>,
		response: { data: BRAND_KIT } satisfies ApiResponse<BrandKit>,
	},
} satisfies Record<string, OperationExample>;
