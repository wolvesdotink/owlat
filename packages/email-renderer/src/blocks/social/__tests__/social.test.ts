import { describe, it, expect } from 'vitest';
import { renderSocialContent } from '../index';
import type { SocialBlockContent } from '@owlat/shared';

const makeContent = (overrides?: Partial<SocialBlockContent>): SocialBlockContent => ({
	links: [
		{ platform: 'twitter', url: 'https://x.com/test', enabled: true },
		{ platform: 'facebook', url: 'https://facebook.com/test', enabled: true },
	],
	iconStyle: 'filled',
	align: 'center',
	iconSize: 32,
	iconSpacing: 8,
	iconColor: '#333333',
	...overrides,
});

describe('renderSocialContent', () => {
	it('derives default icon URL from platform and iconStyle', () => {
		const html = renderSocialContent(makeContent());
		expect(html).toContain('/social-icons/filled/twitter.png');
		expect(html).toContain('/social-icons/filled/facebook.png');
	});

	it('derives outline icon URL when iconStyle is outline', () => {
		const html = renderSocialContent(makeContent({ iconStyle: 'outline' }));
		expect(html).toContain('/social-icons/outline/twitter.png');
	});

	it('uses custom iconUrl when provided', () => {
		const html = renderSocialContent(makeContent({
			links: [
				{ platform: 'twitter', url: 'https://x.com/test', enabled: true, iconUrl: 'https://cdn.example.com/custom-x.png' },
			],
		}));
		expect(html).toContain('https://cdn.example.com/custom-x.png');
		expect(html).not.toContain('/social-icons/filled/twitter.png');
	});

	it('sets alt attribute to platform name on img tag', () => {
		const html = renderSocialContent(makeContent());
		expect(html).toContain('alt="X"');
		expect(html).toContain('alt="Facebook"');
	});

	it('renders vertical mode with tr per icon', () => {
		const html = renderSocialContent(makeContent({ mode: 'vertical' }));
		const trMatches = html.match(/<tr>/g) || [];
		expect(trMatches.length).toBe(2);
	});

	it('does not render labels (showLabels ignored)', () => {
		const html = renderSocialContent(makeContent({ showLabels: true }));
		// Labels are not rendered — icons use alt text for accessibility
		expect(html).not.toMatch(/>X<\/(?:div|span|p)>/);
		expect(html).toContain('alt="X"');
	});

	it('returns empty string when no enabled links with URLs', () => {
		const html = renderSocialContent(makeContent({
			links: [
				{ platform: 'twitter', url: '', enabled: true },
				{ platform: 'facebook', url: 'https://fb.com', enabled: false },
			],
		}));
		expect(html).toBe('');
	});
});
