/**
 * Domain Verification Helpers
 *
 * This module provides functions to verify that email sending domains
 * are properly configured and verified before allowing emails to be sent.
 */

import type { DatabaseReader } from '../../_generated/server';
import { extractDomain } from '@owlat/shared';

/** Maximum age for domain verification (24 hours) */
const DOMAIN_VERIFICATION_MAX_AGE_HOURS = 24;

/**
 * Extract the domain from an email address or "Name <email>" format.
 * Delegates to the shared `extractDomain` (throws on un-parseable input) so the
 * sending-domain gate, the MTA, and every other domain derivation agree.
 */
export function extractDomainFromEmail(fromAddress: string): string {
	return extractDomain(fromAddress);
}

/**
 * Build an RFC 5322 From header. With a display name, returns
 * `Name <email>`; otherwise the bare address. Single source of truth for
 * the From-header shape across every send producer.
 */
export function formatFromAddress(email: string, name?: string): string {
	return name ? `${name} <${email}>` : email;
}

/**
 * Check if a domain is verified
 */
export async function isDomainVerified(
	db: DatabaseReader,
	domain: string
): Promise<boolean> {
	const domainRecord = await db
		.query('domains')
		.withIndex('by_domain', (q) =>
			q.eq('domain', domain.toLowerCase())
		)
		.first();

	if (!domainRecord) {
		return false;
	}

	return domainRecord.status === 'verified';
}

/**
 * Check if domain verification is fresh (within max age hours)
 */
export async function isDomainVerificationFresh(
	db: DatabaseReader,
	domain: string,
	maxAgeHours: number = DOMAIN_VERIFICATION_MAX_AGE_HOURS
): Promise<{ fresh: boolean; lastVerifiedAt?: number; stale: boolean }> {
	const domainRecord = await db
		.query('domains')
		.withIndex('by_domain', (q) =>
			q.eq('domain', domain.toLowerCase())
		)
		.first();

	if (!domainRecord) {
		return { fresh: false, stale: false };
	}

	if (domainRecord.status !== 'verified') {
		return { fresh: false, lastVerifiedAt: domainRecord.lastVerifiedAt, stale: false };
	}

	if (!domainRecord.lastVerifiedAt) {
		// Verified but never checked - treat as stale
		return { fresh: false, lastVerifiedAt: undefined, stale: true };
	}

	const now = Date.now();
	const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
	const stale = now - domainRecord.lastVerifiedAt > maxAgeMs;

	return {
		fresh: !stale,
		lastVerifiedAt: domainRecord.lastVerifiedAt,
		stale,
	};
}

/**
 * Validate that a domain can be used for sending
 * Throws an error if the domain is not verified
 */
export async function validateDomainForSending(
	db: DatabaseReader,
	fromAddress: string
): Promise<{ domain: string; verified: boolean; warning?: string }> {
	const domain = extractDomainFromEmail(fromAddress);

	// Check if domain exists and its status
	const domainRecord = await db
		.query('domains')
		.withIndex('by_domain', (q) =>
			q.eq('domain', domain.toLowerCase())
		)
		.first();

	if (domainRecord?.status === 'registering') {
		throw new Error(
			`Cannot send email: domain "${domain}" is still being registered. ` +
				`Please wait for registration to complete and verify DNS records in Settings > Domains.`
		);
	}

	// Check if domain is verified
	const verified = await isDomainVerified(db, domain);

	if (!verified) {
		throw new Error(
			`Cannot send email: domain "${domain}" is not verified. ` +
				`Please verify this domain in Settings > Domains before sending emails.`
		);
	}

	// Check if verification is fresh
	const freshness = await isDomainVerificationFresh(db, domain);

	let warning: string | undefined;
	if (freshness.stale) {
		warning = `Domain "${domain}" verification is stale (last checked ${
			freshness.lastVerifiedAt ? new Date(freshness.lastVerifiedAt).toISOString() : 'never'
		}). Consider re-verifying DNS records.`;
	}

	return {
		domain,
		verified: true,
		warning,
	};
}

/**
 * Get verification status for a domain
 */
export async function getDomainVerificationStatus(
	db: DatabaseReader,
	domain: string
): Promise<{
	exists: boolean;
	status?: 'registering' | 'pending' | 'verified' | 'failed';
	verified: boolean;
	lastVerifiedAt?: number;
	stale: boolean;
}> {
	const domainRecord = await db
		.query('domains')
		.withIndex('by_domain', (q) =>
			q.eq('domain', domain.toLowerCase())
		)
		.first();

	if (!domainRecord) {
		return {
			exists: false,
			verified: false,
			stale: false,
		};
	}

	const freshness = await isDomainVerificationFresh(db, domain);

	return {
		exists: true,
		status: domainRecord.status,
		verified: domainRecord.status === 'verified',
		lastVerifiedAt: domainRecord.lastVerifiedAt,
		stale: freshness.stale,
	};
}
