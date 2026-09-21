/**
 * Per-sender remote-image allowlist — the pure half.
 *
 * The invariant worth a test above all others: being on the allowlist loads a
 * sender's IMAGES and never their tracking pixels. The banner resolver is the
 * place that could quietly break it, so it is asserted directly.
 */
import { describe, it, expect } from 'vitest';
import {
	isPostboxSenderImageAllowed,
	postboxSenderKey,
	postboxSenderTrustLabel,
	resolvePostboxImageBanner,
} from '../postboxImageAllowlist';

describe('postboxSenderKey', () => {
	it('reads the address out of every From header shape, lowercased', () => {
		expect(postboxSenderKey('News@Stratechery.com')).toBe('news@stratechery.com');
		expect(postboxSenderKey('<News@Stratechery.com>')).toBe('news@stratechery.com');
		expect(postboxSenderKey('Ben Thompson <news@stratechery.com>')).toBe('news@stratechery.com');
		expect(postboxSenderKey('  news@stratechery.com  ')).toBe('news@stratechery.com');
	});

	it('returns null when there is no address to key a grant on', () => {
		expect(postboxSenderKey(undefined)).toBeNull();
		expect(postboxSenderKey('')).toBeNull();
		expect(postboxSenderKey('Ben Thompson')).toBeNull();
		expect(postboxSenderKey('news@localhost')).toBeNull();
	});
});

describe('postboxSenderTrustLabel', () => {
	it('names the domain, which is what the reader recognises', () => {
		expect(postboxSenderTrustLabel('Ben <news@stratechery.com>')).toBe('stratechery.com');
	});

	it('is null when no address could be read', () => {
		expect(postboxSenderTrustLabel('Ben Thompson')).toBeNull();
	});
});

describe('isPostboxSenderImageAllowed', () => {
	const entries = [{ senderEmail: 'news@stratechery.com' }];

	it('matches on the canonical address regardless of header shape', () => {
		expect(isPostboxSenderImageAllowed(entries, 'Ben <News@Stratechery.com>')).toBe(true);
	});

	it('does not match a different sender, an unloaded list, or a nameless header', () => {
		expect(isPostboxSenderImageAllowed(entries, 'spam@evil.example')).toBe(false);
		expect(isPostboxSenderImageAllowed(undefined, 'news@stratechery.com')).toBe(false);
		expect(isPostboxSenderImageAllowed(entries, 'Ben Thompson')).toBe(false);
	});
});

describe('resolvePostboxImageBanner', () => {
	const base = {
		hasRemoteImages: true,
		showImages: false,
		loadEverything: false,
		isSenderAllowed: false,
		hasSenderKey: true,
		trackerCount: 0,
	};

	it('says nothing when the body carries no remote images', () => {
		expect(resolvePostboxImageBanner({ ...base, hasRemoteImages: false })).toEqual({
			kind: 'none',
		});
	});

	it('offers the sender grant only when there is an address to key it on', () => {
		expect(resolvePostboxImageBanner(base)).toEqual({
			kind: 'blocked',
			trackerCount: 0,
			canTrustSender: true,
		});
		expect(resolvePostboxImageBanner({ ...base, hasSenderKey: false })).toEqual({
			kind: 'blocked',
			trackerCount: 0,
			canTrustSender: false,
		});
	});

	it('reports the auto-load when the sender is trusted', () => {
		expect(resolvePostboxImageBanner({ ...base, showImages: true, isSenderAllowed: true })).toEqual(
			{ kind: 'auto-allowed', trackerCount: 0 }
		);
	});

	it('KEEPS reporting withheld trackers for a trusted sender', () => {
		// The whole point of the narrow grant: trusting a sender loads their
		// images and never their pixels, so the count survives into the banner.
		expect(
			resolvePostboxImageBanner({
				...base,
				showImages: true,
				isSenderAllowed: true,
				trackerCount: 3,
			})
		).toEqual({ kind: 'auto-allowed', trackerCount: 3 });
	});

	it('reports withheld trackers after a one-off "Show once"', () => {
		expect(resolvePostboxImageBanner({ ...base, showImages: true, trackerCount: 2 })).toEqual({
			kind: 'trackers-blocked',
			trackerCount: 2,
		});
	});

	it('goes quiet once the user escalated to loading everything', () => {
		expect(
			resolvePostboxImageBanner({
				...base,
				showImages: true,
				loadEverything: true,
				isSenderAllowed: true,
				trackerCount: 2,
			})
		).toEqual({ kind: 'none' });
	});

	it('says nothing when images are shown and there was nothing to withhold', () => {
		expect(resolvePostboxImageBanner({ ...base, showImages: true })).toEqual({ kind: 'none' });
	});
});
