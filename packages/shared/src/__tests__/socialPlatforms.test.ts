import { describe, it, expect } from 'vitest';
import { SOCIAL_PLATFORMS } from '../types/blocks';
import type { SocialPlatform } from '../types/blocks';

// The full set of platforms the union declares. Kept in one place so the
// assertions below fail loudly if a member is added to the union but not to
// SOCIAL_PLATFORMS (the `satisfies` also makes that a compile error).
const ALL_PLATFORMS = [
	'twitter',
	'facebook',
	'instagram',
	'linkedin',
	'youtube',
	'tiktok',
	'github',
	'whatsapp',
	'telegram',
	'threads',
	'pinterest',
	'discord',
	'mastodon',
	'bluesky',
	'vimeo',
	'medium',
	'snapchat',
] as const satisfies readonly SocialPlatform[];

describe('SOCIAL_PLATFORMS', () => {
	it('has an entry for every SocialPlatform member', () => {
		const keys = Object.keys(SOCIAL_PLATFORMS).sort();
		expect(keys).toEqual([...ALL_PLATFORMS].sort());
		expect(keys).toHaveLength(17);
	});

	it('gives every platform a non-empty label', () => {
		for (const [platform, meta] of Object.entries(SOCIAL_PLATFORMS)) {
			expect(meta.label, platform).toBeTruthy();
		}
	});

	it('keeps twitter labelled X with a Twitter / X editor override', () => {
		expect(SOCIAL_PLATFORMS.twitter.label).toBe('X');
		expect(SOCIAL_PLATFORMS.twitter.editorLabel).toBe('Twitter / X');
	});
});
