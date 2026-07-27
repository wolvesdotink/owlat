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

/**
 * The token payload is `${organizationId}.${probeId}`.
 *
 * The organization travels IN the signed payload so the recording mutation has
 * an INDEPENDENT claim to assert against the row — exactly the boundary its
 * three sibling probe-writing mutations hold. Reading the org off the row it is
 * about to write would be a tautology, not a check. `.` is a safe separator:
 * `makeContactToken` already forbids `:` in a payload, a probe id is
 * `sp_` + 22 lowercase base32 chars, and the org id is matched up to the LAST
 * separator so only the probe id's shape has to be constrained.
 */
function encodeSeedProbeTokenPayload(organizationId: string, probeId: string): string {
	return `${organizationId}.${probeId}`;
}

/** The one-click pair for a seed shadow copy. Target: POST /unsub/probe/{token}. */
export function getSeedProbeListUnsubscribeHeader(
	convexSiteUrl: string,
	organizationId: string,
	probeId: string
): { listUnsubscribe: string; listUnsubscribePost: string } {
	const token = makeContactToken(
		SEED_PROBE_TOKEN_PREFIX,
		encodeSeedProbeTokenPayload(organizationId, probeId)
	);
	return {
		listUnsubscribe: `<${convexSiteUrl}/unsub/probe/${encodeURIComponent(token)}>`,
		listUnsubscribePost: 'List-Unsubscribe=One-Click',
	};
}

/**
 * The result of validating a seed-probe one-click token. Deliberately NOT
 * `TokenValidation`: the payload of a probe token is an ORG + PROBE id, and
 * reading it out of a field called `contactId` would erase at the boundary
 * exactly the namespace separation that makes the token safe.
 */
export type SeedProbeTokenValidation =
	| { valid: true; organizationId: string; probeId: string }
	| { valid: false; reason: string };

/** Validate a seed-probe one-click token (called by the httpAction handler). */
export const validateSeedProbeToken = internalAction({
	args: { token: v.string() },
	handler: async (_ctx, args): Promise<SeedProbeTokenValidation> => {
		const result = verifyContactToken(SEED_PROBE_TOKEN_PREFIX, args.token);
		// Map at the boundary: the codec's field is named for the contact tokens
		// it was written for; this namespace carries an org + probe id and nothing
		// else.
		if (!result.valid) return { valid: false, reason: result.reason ?? 'invalid_token' };
		const separator = result.contactId.lastIndexOf('.');
		if (separator <= 0) return { valid: false, reason: 'invalid_format' };
		return {
			valid: true,
			organizationId: result.contactId.slice(0, separator),
			probeId: result.contactId.slice(separator + 1),
		};
	},
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
