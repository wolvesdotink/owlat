'use node';

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { makeContactToken, verifyContactToken } from './contactToken';

// Unsubscribe tokens use the shared contact-token codec with an empty namespace
// prefix. Format: {contactId}:{timestamp}:{signature}, signed with UNSUBSCRIBE_SECRET.
export function generateUnsubscribeToken(contactId: string): string {
	return makeContactToken('', contactId);
}

// Internal action to validate unsubscribe token (called by httpAction handlers)
export const validateToken = internalAction({
	args: { token: v.string() },
	handler: async (_ctx, args) => {
		return verifyContactToken('', args.token);
	},
});

// Generate the full unsubscribe URL
export function getUnsubscribeUrl(siteUrl: string, contactId: string): string {
	const token = generateUnsubscribeToken(contactId);
	return `${siteUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Token namespace for a deliverability SEED PROBE's one-click target.
 *
 * A shadow copy has no contact, but it MUST carry the same RFC 8058 header
 * pair the real send carries: the worker asserts it before dispatch, and
 * Gmail/Yahoo's bulk-sender rules weigh it — a probe without it would measure
 * a materially different message than subscribers receive (and, before this,
 * simply threw). The payload is the opaque probe id, so the header still
 * carries no recipient or campaign PII, and the namespace prefix means a probe
 * token can never be replayed against the contact unsubscribe endpoint.
 */
export const SEED_PROBE_TOKEN_PREFIX = 'seedprobe:';

/** The one-click pair for a seed shadow copy. Target: POST /unsub/probe/{token}. */
export function getSeedProbeListUnsubscribeHeader(
	convexSiteUrl: string,
	probeId: string
): { listUnsubscribe: string; listUnsubscribePost: string } {
	const token = makeContactToken(SEED_PROBE_TOKEN_PREFIX, probeId);
	return {
		listUnsubscribe: `<${convexSiteUrl}/unsub/probe/${encodeURIComponent(token)}>`,
		listUnsubscribePost: 'List-Unsubscribe=One-Click',
	};
}

/** Validate a seed-probe one-click token (called by the httpAction handler). */
export const validateSeedProbeToken = internalAction({
	args: { token: v.string() },
	handler: async (_ctx, args) => verifyContactToken(SEED_PROBE_TOKEN_PREFIX, args.token),
});

// Generate List-Unsubscribe header value (RFC 8058 one-click unsubscribe)
export function getListUnsubscribeHeader(
	convexSiteUrl: string,
	contactId: string
): { listUnsubscribe: string; listUnsubscribePost: string } {
	const token = generateUnsubscribeToken(contactId);
	const unsubscribeUrl = `${convexSiteUrl}/unsub/${encodeURIComponent(token)}`;
	return {
		// List-Unsubscribe header — HTTPS one-click endpoint (mailto form intentionally omitted)
		listUnsubscribe: `<${unsubscribeUrl}>`,
		// List-Unsubscribe-Post header for one-click unsubscribe (RFC 8058)
		listUnsubscribePost: 'List-Unsubscribe=One-Click',
	};
}
