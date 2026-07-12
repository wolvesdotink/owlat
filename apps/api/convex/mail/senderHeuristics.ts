/**
 * Sender-impersonation heuristics computed AT INGEST (Sealed Mail A4).
 *
 * The content scanner (`@owlat/email-scanner`) sees only the message headers
 * and body — it flags a From domain that homoglyph/punycode-spoofs a real one
 * and a Reply-To on a different domain. Two further signals need data the
 * scanner cannot see, so they are derived here against the mailbox's own
 * history and the workspace's contact book:
 *
 *   • isFirstTimeSender — no prior message from this address has ever landed in
 *     this mailbox. On its own this is weak (everyone is new once), but paired
 *     with a spoof/lookalike signal it sharpens the reader's judgement.
 *   • lookalikeOfContactDomain — the From domain is a near-miss (bounded edit
 *     distance) of a domain a known contact actually uses, e.g. `paypa1.com`
 *     when a contact is `@paypal.com`. Equal domains never match — only a
 *     look-alike does.
 *
 * The result is persisted on `mailMessages.senderHeuristics` and surfaced by
 * the reader's sender badge as secondary detail lines — never as a second
 * badge, and never as a claim stronger than what was actually checked. ALL
 * fields optional: an absent object means "nothing notable", which the reader
 * renders as no extra lines rather than a false "all clear".
 */

import {
	extractHeaderDomain,
	registrableDomain,
	scanSenderImpersonation,
} from '@owlat/email-scanner';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { SenderHeuristics } from '../lib/senderHeuristicsValidator';

// Persisted shape is the single source of truth in `lib/senderHeuristicsValidator`
// (`senderHeuristicsValidator`); the schema references that validator and this
// type is derived from it, so the field set never drifts across the three sites.
export type { SenderHeuristics };

/**
 * Levenshtein edit distance, bounded early-exit at `max`. Small inputs
 * (domain strings), so the full O(n·m) table is fine; the bound just lets us
 * bail once we know the pair is too far apart to matter.
 */
function boundedEditDistance(a: string, b: string, max: number): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const prev: number[] = Array.from({ length: b.length + 1 }, () => 0);
	const curr: number[] = Array.from({ length: b.length + 1 }, () => 0);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0]!;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
			if (curr[j]! < rowMin) rowMin = curr[j]!;
		}
		if (rowMin > max) return max + 1;
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
	}
	return prev[b.length]!;
}

// A near-miss is 1–2 single-character edits (paypa1.com→paypal.com). Zero is an
// exact match (a legitimate known contact — never flagged), and 3+ is too far
// to be a deliberate look-alike without drowning in false positives.
const LOOKALIKE_MAX_EDITS = 2;
// Upper bound on contact rows scanned when collecting known domains. Best-effort
// heuristic: a miss past this window costs a secondary badge line, never a false
// security claim, so an unbounded table scan is not worth the read amplification.
const CONTACT_SCAN_LIMIT = 2000;

/**
 * Collect the distinct registrable domains of the workspace's contacts, bounded
 * by CONTACT_SCAN_LIMIT. Single-org deployment, so no org filter is needed;
 * soft-deleted contacts are skipped.
 */
async function collectContactDomains(ctx: MutationCtx): Promise<Set<string>> {
	const domains = new Set<string>();
	const contacts = await ctx.db
		.query('contacts')
		.withIndex('by_deleted_at', (q) => q.eq('deletedAt', undefined))
		.take(CONTACT_SCAN_LIMIT);
	for (const contact of contacts) {
		if (!contact.email) continue;
		const domain = extractHeaderDomain(contact.email);
		if (domain) domains.add(registrableDomain(domain));
	}
	return domains;
}

/**
 * Compute the ingest-side sender heuristics for a delivered message. Returns
 * undefined when no signal fired (so the caller stores nothing).
 */
export async function computeSenderHeuristics(
	ctx: MutationCtx,
	params: {
		mailbox: Doc<'mailboxes'>;
		/** Normalised sender address (localpart@domain). */
		fromAddress: string;
		/** Raw From header value, for the content-scanner spoof check. */
		from?: string;
		/** Raw Reply-To header value, when present. */
		replyTo?: string;
	}
): Promise<SenderHeuristics | undefined> {
	const result: SenderHeuristics = {};

	// 1. Content-visible spoof signals — reuse the scanner rule so the badge and
	// the spam score agree on what "spoofed" means.
	const headerFlags = scanSenderImpersonation(params.from ?? params.fromAddress, params.replyTo);
	if (headerFlags.some((f) => f.type === 'sender_impersonation')) {
		result.isFromDomainSpoofed = true;
	}
	if (headerFlags.some((f) => f.type === 'reply_to_mismatch')) {
		result.isReplyToMismatch = true;
	}

	// 2. First-time sender — no earlier message from this address in this mailbox.
	const prior = await ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_from', (q) =>
			q.eq('mailboxId', params.mailbox._id).eq('fromAddress', params.fromAddress)
		)
		.first();
	if (!prior) {
		result.isFirstTimeSender = true;
	}

	// 3. Lookalike-of-known-contact — the From domain is a bounded edit-distance
	// near-miss of a domain a real contact uses (but not an exact match).
	const fromDomain = extractHeaderDomain(params.from ?? params.fromAddress);
	if (fromDomain) {
		const fromRegistrable = registrableDomain(fromDomain);
		const contactDomains = await collectContactDomains(ctx);
		if (!contactDomains.has(fromRegistrable)) {
			for (const known of contactDomains) {
				const distance = boundedEditDistance(fromRegistrable, known, LOOKALIKE_MAX_EDITS);
				if (distance >= 1 && distance <= LOOKALIKE_MAX_EDITS) {
					result.lookalikeOfContactDomain = known;
					break;
				}
			}
		}
	}

	const notable =
		result.isFromDomainSpoofed ||
		result.isReplyToMismatch ||
		result.isFirstTimeSender ||
		result.lookalikeOfContactDomain !== undefined;
	return notable ? result : undefined;
}
