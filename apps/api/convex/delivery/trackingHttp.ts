import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { getClientIp } from '../publicRateLimit';
import { isValidConvexId, isSafeRedirectUrl } from '../lib/inputGuards';
import { getOptional } from '../lib/env';
import { logError } from '../lib/runtimeLog';

// Base64url-encode raw bytes WITHOUT padding, matching Node's
// `createHmac(...).digest('base64url')` used on the encode side (transform.ts).
function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Constant-time string compare for the tracking signature.
function timingSafeStrEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

/**
 * Verify the HMAC that binds a click-tracking redirect target to its
 * emailSendId. The encode side (delivery/sendComposition/transform.ts) signs
 * `${emailSendId}.${encodedUrl}` with UNSUBSCRIBE_SECRET; an attacker who knows
 * a valid emailSendId (every recipient gets one) but cannot forge the signature
 * therefore cannot swap the encoded-URL segment to point the trusted tracking
 * domain at an arbitrary host (open redirect / phishing).
 */
async function verifyTrackingSignature(
	emailSendId: string,
	encodedUrl: string,
	signature: string,
): Promise<boolean> {
	const secret = getOptional('UNSUBSCRIBE_SECRET');
	if (!secret || !signature) return false;
	try {
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const mac = await crypto.subtle.sign(
			'HMAC',
			key,
			new TextEncoder().encode(`${emailSendId}.${encodedUrl}`),
		);
		const expected = bytesToBase64Url(new Uint8Array(mac));
		return timingSafeStrEqual(expected, signature);
	} catch {
		return false;
	}
}

// 1x1 transparent GIF pixel (as Uint8Array instead of Buffer)
// Base64: R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7
const TRACKING_PIXEL = new Uint8Array([
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
	0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
]);

// Helper function to decode base64url string (Web API equivalent of Buffer)
function base64UrlDecode(str: string): string {
	// Convert base64url to base64
	let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
	// Add padding if needed
	while (base64.length % 4) {
		base64 += '=';
	}
	// Decode base64 to string
	return atob(base64);
}

// HTTP action for open tracking (tracking pixel).
//
// INTENTIONAL ASYMMETRY vs trackClick: the open pixel accepts any well-formed
// emailSendId with NO signature, whereas trackClick requires an HMAC that binds
// the redirect target to its emailSendId. The asymmetry is deliberate, not an
// oversight:
//   - The id must be embedded in the <img> src so the mail client can fetch it;
//     it is therefore already visible to the recipient and cannot be a secret.
//     A signature would only bind the id to itself (trackClick signs id+URL —
//     there is a separate target to forge; an open has none).
//   - Forging an open exposes NO data and grants no redirect: it can only
//     inflate the open count for a known send. The per-IP `emailTracking` rate
//     limit below caps that abuse; opens are analytics-only.
// Future option: sign the pixel path (id + a short expiry) the same way
// trackClick signs its target, if open-count integrity ever needs to be
// stronger than rate-limited best-effort. See CONTEXT.md "Outbound lifecycle".
export const trackOpen = httpAction(async (ctx, request) => {
	// Extract emailSendId from URL path
	const url = new URL(request.url);
	const pathParts = url.pathname.split('/');
	// Expected path: /t/o/{emailSendId}
	const emailSendId = pathParts[3];

	// Response headers for tracking pixel
	const pixelHeaders = {
		'Content-Type': 'image/gif',
		'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
		Pragma: 'no-cache',
		Expires: '0',
	};

	if (!emailSendId || !isValidConvexId(emailSendId)) {
		// Return pixel anyway to avoid broken images
		return new Response(TRACKING_PIXEL, {
			status: 200,
			headers: pixelHeaders,
		});
	}

	// Rate limit check (graceful - always return pixel, but skip recording if rate limited)
	const ip = getClientIp(request);
	const { ok } = await ctx.runMutation(internal.publicRateLimit.checkPublicRateLimit, {
		limitType: 'emailTracking',
		key: ip,
	});

	// Only record if not rate limited
	if (ok) {
		try {
			// Record the open event (fire and forget - we return pixel regardless)
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: {
					kind: 'campaign',
					id: emailSendId as Id<'emailSends'>,
				},
				transition: { to: 'opened', at: Date.now() },
			});
		} catch {
			// Log error but still return pixel to avoid broken images
			logError('Failed to record open event for:', emailSendId);
		}
	}

	// Always return 1x1 transparent GIF
	return new Response(TRACKING_PIXEL, {
		status: 200,
		headers: pixelHeaders,
	});
});

// HTTP action for click tracking (redirect)
export const trackClick = httpAction(async (ctx, request) => {
	const url = new URL(request.url);
	const pathParts = url.pathname.split('/');
	// Expected path: /t/c/{emailSendId}/{base64EncodedUrl}/{signature}
	const emailSendId = pathParts[3];
	const encodedUrl = pathParts[4];
	const signature = pathParts[5];

	// Default redirect URL if something goes wrong
	let redirectUrl = '/';
	let hasValidTarget = false;

	if (emailSendId && encodedUrl && signature) {
		try {
			// Reject any target whose HMAC signature does not bind it to this
			// emailSendId — without this an attacker holding one valid tracking
			// link could repoint the trusted tracking domain at an arbitrary host
			// (open redirect). Only decode + honor the URL once the signature checks.
			if (await verifyTrackingSignature(emailSendId, encodedUrl, signature)) {
				// Decode the URL (base64url encoded) using Web API
				const decodedUrl = base64UrlDecode(encodedUrl);
				if (isSafeRedirectUrl(decodedUrl)) {
					redirectUrl = new URL(decodedUrl).toString();
					hasValidTarget = true;
				}
			} else {
				logError('Rejected tracking redirect with invalid signature for:', emailSendId);
			}
		} catch {
			logError('Failed to decode URL:', encodedUrl);
		}
	}

	if (!emailSendId || !isValidConvexId(emailSendId)) {
		hasValidTarget = false;
		redirectUrl = '/';
	}

	if (hasValidTarget && emailSendId) {
		const send = await ctx.runQuery(internal.delivery.tracking.getEmailSendForTracking, {
			emailSendId: emailSendId as Id<'emailSends'>,
		});
		if (!send) {
			hasValidTarget = false;
			redirectUrl = '/';
		}
	}

	// Rate limit check (graceful - always redirect, but skip recording if rate limited)
	const ip = getClientIp(request);
	const { ok } = await ctx.runMutation(internal.publicRateLimit.checkPublicRateLimit, {
		limitType: 'emailTracking',
		key: ip,
	});

	// Only record if not rate limited
	if (ok && hasValidTarget && emailSendId && encodedUrl) {
		try {
			// Record the click event
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: {
					kind: 'campaign',
					id: emailSendId as Id<'emailSends'>,
				},
				transition: {
					to: 'clicked',
					at: Date.now(),
					url: redirectUrl,
				},
			});
		} catch {
			// Log error but still redirect user
			logError('Failed to record click event for:', emailSendId);
		}
	}

	// Always redirect to the original URL
	return new Response(null, {
		status: 302,
		headers: {
			Location: redirectUrl,
			'Cache-Control': 'no-store, no-cache, must-revalidate',
		},
	});
});
