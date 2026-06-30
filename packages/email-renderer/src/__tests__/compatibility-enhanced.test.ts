import { describe, it, expect } from 'vitest';
import { emailClients } from '@owlat/shared';
import {
	getBlockCompatibility,
	getPropertyCompatibility,
	getAudienceReach,
	scoreBlockCompatibility,
} from '../compatibility';
// Side-effect import: ensures all built-in Block modules are registered before
// the compatibility walker runs.
import '../blocks';

describe('Compatibility Data Improvements', () => {
	describe('Outlook New (split)', () => {
		it('outlookNew is present in fullSupport entries', () => {
			const textCompat = getBlockCompatibility('text');
			for (const feat of textCompat) {
				expect(feat.support.outlookNew).toBeDefined();
			}
		});

		it('outlookNew defaults to full for most features', () => {
			const buttonCompat = getBlockCompatibility('button');
			const borderRadius = buttonCompat.find((f) => f.feature === 'border-radius');
			expect(borderRadius?.support.outlookNew).toBe('full');
		});
	});

	describe('Email Client Info', () => {
		it('all clients have metadata', () => {
			const clientKeys = Object.keys(emailClients);
			expect(clientKeys.length).toBe(12);
			for (const key of clientKeys) {
				const info = emailClients[key as keyof typeof emailClients];
				expect(info.name).toBeTruthy();
				expect(info.renderEngine).toBeTruthy();
				expect(info.marketSharePercent).toBeGreaterThan(0);
			}
		});

		it('outlookDesktop uses word engine', () => {
			expect(emailClients.outlookDesktop.renderEngine).toBe('word');
		});

		it('outlookNew uses blink engine', () => {
			expect(emailClients.outlookNew.renderEngine).toBe('blink');
		});
	});

	describe('Audience Reach', () => {
		it('full support returns 100%', () => {
			const fullCompat = getBlockCompatibility('text').find((f) => f.feature === 'text-align: justify');
			expect(fullCompat).toBeDefined();
			const reach = getAudienceReach(fullCompat!.support);
			expect(reach).toBe(100);
		});

		it('partial support returns less than 100%', () => {
			const webFonts = getBlockCompatibility('text').find((f) => f.feature === 'Web fonts');
			expect(webFonts).toBeDefined();
			const reach = getAudienceReach(webFonts!.support);
			expect(reach).toBeLessThan(100);
			expect(reach).toBeGreaterThan(0);
		});

		it('accepts custom weights', () => {
			const webFonts = getBlockCompatibility('text').find((f) => f.feature === 'Web fonts');
			const reachDefault = getAudienceReach(webFonts!.support);
			const reachCustom = getAudienceReach(webFonts!.support, {
				appleMail: 90, // Pretend Apple Mail is 90% of audience
			});
			// Custom weights should change the result
			expect(reachCustom).not.toBe(reachDefault);
		});
	});

	describe('Block Compatibility Score', () => {
		it('returns score for basic text block', () => {
			const result = scoreBlockCompatibility('text', { fontSize: 16, textColor: '#333' });
			expect(result.score).toBeGreaterThan(0);
			expect(result.score).toBeLessThanOrEqual(100);
		});

		it('text block with web font has lower score', () => {
			const basic = scoreBlockCompatibility('text', { fontSize: 16 });
			const withFont = scoreBlockCompatibility('text', { fontFamily: 'Roboto' });
			expect(withFont.score).toBeLessThanOrEqual(basic.score);
		});

		it('returns full and partial support clients', () => {
			const result = scoreBlockCompatibility('button', { borderRadius: 8 });
			expect(Array.isArray(result.fullSupportClients)).toBe(true);
			expect(Array.isArray(result.partialSupportClients)).toBe(true);
		});
	});

	describe('Missing Property Entries', () => {
		it('video block has playButtonColor property', () => {
			const props = getPropertyCompatibility('video', 'playButtonColor');
			expect(props.length).toBe(1);
		});

		it('carousel block has thumbnailWidth property', () => {
			const props = getPropertyCompatibility('carousel', 'thumbnailWidth');
			expect(props.length).toBe(1);
		});

		it('list block has bulletColor property', () => {
			const props = getPropertyCompatibility('list', 'bulletColor');
			expect(props.length).toBe(1);
		});

		it('progressBar block has labelPosition property', () => {
			const props = getPropertyCompatibility('progressBar', 'labelPosition');
			expect(props.length).toBe(1);
		});

		it('divider block has style property', () => {
			const props = getPropertyCompatibility('divider', 'style');
			expect(props.length).toBe(1);
		});

		it('spacer block has height property', () => {
			const props = getPropertyCompatibility('spacer', 'height');
			expect(props.length).toBe(1);
		});
	});

	describe('Degradation Impact', () => {
		it('image borderRadius has visual impact', () => {
			const props = getPropertyCompatibility('image', 'borderRadius');
			expect(props[0]?.degradationImpact).toBe('visual');
		});

		it('carousel thumbnailWidth has functional impact', () => {
			const props = getPropertyCompatibility('carousel', 'thumbnailWidth');
			expect(props[0]?.degradationImpact).toBe('functional');
		});
	});

	describe('Fix Suggestions', () => {
		it('image borderRadius has fix suggestions', () => {
			const props = getPropertyCompatibility('image', 'borderRadius');
			expect(props[0]?.fixes).toBeDefined();
			expect(props[0]!.fixes!.length).toBeGreaterThan(0);
			expect(props[0]!.fixes![0].action).toBe('remove-property');
		});

		it('column backgroundImage has set-fallback fix', () => {
			const props = getPropertyCompatibility('columns', 'columnStyles.backgroundImage');
			expect(props[0]?.fixes).toBeDefined();
			expect(props[0]!.fixes!.some((f) => f.action === 'set-fallback')).toBe(true);
		});

		it('progressBar labelPosition has replace-value fix', () => {
			const props = getPropertyCompatibility('progressBar', 'labelPosition');
			expect(props[0]?.fixes).toBeDefined();
			expect(props[0]!.fixes!.some((f) => f.action === 'replace-value')).toBe(true);
		});
	});
});
