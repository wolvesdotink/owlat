import { describe, expect, it } from 'vitest';
import {
	ATTACHMENT_SHARE_PATH,
	ATTACHMENT_SHARE_TOKEN_LENGTH,
	attachmentShareExpiryAt,
	attachmentShareState,
	attachmentShareUrl,
	isAttachmentShareServable,
	isAttachmentSharePurgeable,
	isAttachmentShareToken,
	resolveAttachmentShareExpiryDays,
} from '../attachmentShares';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = 1_760_000_000_000;

/**
 * The default lifetime and the purge grace window are module-private — the only
 * supported way to observe either is through the predicate that applies it. The
 * literals are restated here on purpose: they pin the promise the copy makes
 * ("links expire", "the row survives long enough to explain itself") rather than
 * re-deriving it from the implementation, so changing the constant fails here
 * instead of silently redefining the guarantee.
 */
const DEFAULT_EXPIRY_DAYS = 14;
const PURGE_GRACE_MS = 30 * DAY;

describe('isAttachmentShareToken', () => {
	const good = 'a'.repeat(ATTACHMENT_SHARE_TOKEN_LENGTH);

	it('accepts a token of the exact length from the URL alphabet', () => {
		expect(isAttachmentShareToken(good)).toBe(true);
		expect(isAttachmentShareToken(`${'-_9Az'.repeat(6)}xy`)).toBe(true);
	});

	it('rejects a token of the wrong length, so a truncated URL never reads', () => {
		expect(isAttachmentShareToken(good.slice(1))).toBe(false);
		expect(isAttachmentShareToken(`${good}a`)).toBe(false);
	});

	it('rejects anything outside the URL alphabet and the absent cases', () => {
		expect(isAttachmentShareToken(`${good.slice(1)}/`)).toBe(false);
		expect(isAttachmentShareToken(`${good.slice(1)}.`)).toBe(false);
		expect(isAttachmentShareToken(null)).toBe(false);
		expect(isAttachmentShareToken(undefined)).toBe(false);
		expect(isAttachmentShareToken('')).toBe(false);
	});
});

describe('resolveAttachmentShareExpiryDays', () => {
	it('passes every supported choice through', () => {
		expect(resolveAttachmentShareExpiryDays(7)).toBe(7);
		expect(resolveAttachmentShareExpiryDays(14)).toBe(14);
		expect(resolveAttachmentShareExpiryDays(30)).toBe(30);
		expect(resolveAttachmentShareExpiryDays(90)).toBe(90);
	});

	it('falls back to the default for absent, unknown or hostile values', () => {
		expect(resolveAttachmentShareExpiryDays(undefined)).toBe(DEFAULT_EXPIRY_DAYS);
		expect(resolveAttachmentShareExpiryDays(null)).toBe(DEFAULT_EXPIRY_DAYS);
		expect(resolveAttachmentShareExpiryDays(3650)).toBe(DEFAULT_EXPIRY_DAYS);
		expect(resolveAttachmentShareExpiryDays(0)).toBe(DEFAULT_EXPIRY_DAYS);
		expect(resolveAttachmentShareExpiryDays(-1)).toBe(DEFAULT_EXPIRY_DAYS);
	});

	it('never lets an out-of-range lifetime reach the stored expiry', () => {
		expect(attachmentShareExpiryAt(NOW, 3650)).toBe(
			NOW + DEFAULT_EXPIRY_DAYS * DAY
		);
		expect(attachmentShareExpiryAt(NOW, 30)).toBe(NOW + 30 * DAY);
	});
});

describe('attachmentShareState', () => {
	it('is live while the expiry is in the future', () => {
		expect(attachmentShareState({ expiresAt: NOW + 1 }, NOW)).toBe('live');
	});

	it('is expired at the instant of expiry, not one tick later', () => {
		expect(attachmentShareState({ expiresAt: NOW }, NOW)).toBe('expired');
	});

	it('reports revoked even when the link had not yet expired', () => {
		expect(attachmentShareState({ expiresAt: NOW + 10 * DAY, revokedAt: NOW - 1 }, NOW)).toBe(
			'revoked'
		);
	});

	it('reports revoked rather than expired when both are true', () => {
		expect(attachmentShareState({ expiresAt: NOW - 10 * DAY, revokedAt: NOW - 1 }, NOW)).toBe(
			'revoked'
		);
	});

	it('treats a null revokedAt as never revoked', () => {
		expect(attachmentShareState({ expiresAt: NOW + DAY, revokedAt: null }, NOW)).toBe('live');
	});
});

describe('isAttachmentShareServable', () => {
	const live = { expiresAt: NOW + DAY, scope: 'anyone' as const, hasBytes: true };

	it('serves a live, anyone-scoped row that still has bytes', () => {
		expect(isAttachmentShareServable(live, NOW)).toBe(true);
	});

	it('refuses a mailbox-scoped row even while it is live', () => {
		expect(isAttachmentShareServable({ ...live, scope: 'mailbox' }, NOW)).toBe(false);
	});

	it('refuses a revoked row the instant it is revoked', () => {
		expect(isAttachmentShareServable({ ...live, revokedAt: NOW }, NOW)).toBe(false);
	});

	it('refuses an expired row', () => {
		expect(isAttachmentShareServable({ ...live, expiresAt: NOW }, NOW)).toBe(false);
	});

	it('refuses a row whose bytes are already gone', () => {
		expect(isAttachmentShareServable({ ...live, hasBytes: false }, NOW)).toBe(false);
	});
});

describe('isAttachmentSharePurgeable', () => {
	it('never purges a row that still owns bytes', () => {
		expect(
			isAttachmentSharePurgeable(
				{ expiresAt: NOW - 10 * PURGE_GRACE_MS, hasBytes: true },
				NOW
			)
		).toBe(false);
	});

	it('keeps a byte-less row through the grace window so the list can explain it', () => {
		expect(
			isAttachmentSharePurgeable(
				{ expiresAt: NOW - PURGE_GRACE_MS + 1, hasBytes: false },
				NOW
			)
		).toBe(false);
	});

	it('purges once the grace window has fully elapsed', () => {
		expect(
			isAttachmentSharePurgeable(
				{ expiresAt: NOW - PURGE_GRACE_MS, hasBytes: false },
				NOW
			)
		).toBe(true);
	});

	it('measures the grace window from the revocation, not the untouched expiry', () => {
		const row = {
			expiresAt: NOW + 365 * DAY,
			revokedAt: NOW - PURGE_GRACE_MS,
			hasBytes: false,
		};
		expect(isAttachmentSharePurgeable(row, NOW)).toBe(true);
		expect(isAttachmentSharePurgeable({ ...row, revokedAt: NOW - 1 }, NOW)).toBe(false);
	});
});

describe('attachmentShareUrl', () => {
	it('joins the site origin and the token under the route prefix', () => {
		expect(attachmentShareUrl('https://x.convex.site', 'tok')).toBe(
			`https://x.convex.site${ATTACHMENT_SHARE_PATH}tok`
		);
	});

	it('tolerates a trailing slash on the configured origin', () => {
		expect(attachmentShareUrl('https://x.convex.site///', 'tok')).toBe(
			`https://x.convex.site${ATTACHMENT_SHARE_PATH}tok`
		);
	});

	it('percent-encodes the token so it can never break out of the path', () => {
		expect(attachmentShareUrl('https://x.convex.site', 'a/b?c')).toBe(
			`https://x.convex.site${ATTACHMENT_SHARE_PATH}a%2Fb%3Fc`
		);
	});
});
