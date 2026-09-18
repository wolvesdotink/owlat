/**
 * Compose + sign phase: build the exact wire bytes for a job ONCE.
 *
 * The structured job is composed (or the sealed-mail raw MIME taken verbatim),
 * then DKIM-signed over those bytes, and the SAME buffer is retried across every
 * MX host and TLS profile — byte-identical, DKIM-stable retries. The phase also
 * resolves the VERP return path and the RFC 9477 complaint-feedback pair that
 * ride on it.
 */

import type Redis from 'ioredis';
import {
	composeMessage,
	signMessage,
	stripHtml,
	type ComposeAttachment,
} from '@owlat/mail-message';
import { extractDomainOrNull } from '@owlat/shared';
import type { MtaConfig } from '../../config.js';
import type { EmailJob } from '../../types.js';
import { logger } from '../../monitoring/logger.js';
import { cfblEmissionsTotal } from '../../monitoring/collector.js';
import { buildVerpAddress } from '../../bounce/verp.js';
import {
	CFBL_ADDRESS_HEADER,
	CFBL_FEEDBACK_ID_HEADER,
	buildCfblHeaders,
	type CfblHeaderResult,
} from '../../bounce/cfblAddress.js';
import { getDkimOptions, type DkimSigningKey } from '../dkim.js';
import { getReturnPathHost } from '../dkimStore.js';

/** The one payload every delivery attempt for this job writes. */
export interface SignedMessage {
	/** Composed-and-signed RFC 822 bytes, retried unchanged across MX hosts. */
	signedBytes: Buffer;
	/** MAIL FROM: the VERP return path, on this domain's feedback host. */
	verpAddress: string;
	/** Signing domain, or undefined when the message ships unsigned. */
	dkimDomain: string | undefined;
}

/** Lowercased CFBL field names the caller may never set (RFC 9477 §4). */
const RESERVED_CFBL_HEADER_KEYS: ReadonlySet<string> = new Set([
	CFBL_ADDRESS_HEADER.toLowerCase(),
	CFBL_FEEDBACK_ID_HEADER.toLowerCase(),
]);

/**
 * Drop every caller-supplied CFBL field, whatever its letter case.
 *
 * RFC 5322 field names are case-INSENSITIVE, so merging `{...job.headers,
 * ...feedbackHeaders}` is not enough on its own: a `cfbl-address` key is a
 * different object key from `CFBL-Address` and survives the spread, and the
 * composer only de-duplicates structural headers. The wire would then carry an
 * attacker-chosen complaint address ALONGSIDE the signed one, and RFC 9477
 * defines no tiebreak for duplicates — a provider may pick either, or discard
 * both. Either outcome hands a tenant the ability to redirect or silence its own
 * complaint feedback.
 *
 * The strip is UNCONDITIONAL: it runs even when we emit no CFBL pair of our own
 * (no signing key, unaligned host), because an unsigned complaint handle that we
 * cannot verify is strictly worse than no handle at all.
 */
function withoutCfblHeaders(
	headers: Record<string, string> | undefined
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const entries = Object.entries(headers).filter(
		([name]) => !RESERVED_CFBL_HEADER_KEYS.has(name.toLowerCase())
	);
	return entries.length === Object.keys(headers).length ? headers : Object.fromEntries(entries);
}

/**
 * Compose a structured (non-sealed) job into RFC 822 bytes via
 * `@owlat/mail-message`. Preserves the historic payload: html/text (with an
 * HTML-derived fallback), the AMP alternative, decoded attachments, the tracing
 * headers, the VERP envelope, and a From-aligned Message-ID (a caller-supplied
 * Message-ID header wins).
 *
 * `feedbackHeaders` carries the RFC 9477 CFBL pair. Any caller-supplied CFBL
 * field is STRIPPED from `job.headers` first — see {@link withoutCfblHeaders} —
 * so a tenant can neither displace nor duplicate the signed one.
 */
function composeStructured(
	job: EmailJob,
	verpAddress: string,
	feedbackHeaders: Record<string, string>
): { raw: Buffer } {
	const suppliedMessageIdKey = job.headers
		? Object.keys(job.headers).find((h) => h.toLowerCase() === 'message-id')
		: undefined;
	const suppliedMessageId =
		suppliedMessageIdKey && job.headers ? job.headers[suppliedMessageIdKey] : undefined;
	const fromDomain = extractDomainOrNull(job.from) ?? '';

	const attachments: ComposeAttachment[] | undefined =
		job.attachments && job.attachments.length > 0
			? job.attachments.map((a) => ({
					filename: a.filename,
					contentType: a.contentType,
					isInline: false,
					data: Buffer.from(a.contentBase64, 'base64'),
				}))
			: undefined;

	const callerHeaders = withoutCfblHeaders(job.headers);

	return composeMessage({
		from: job.from,
		to: [job.to],
		subject: job.subject,
		html: job.html,
		// Always ship a non-empty text part (multipart/alternative deliverability,
		// RFC 8058 §4): the explicit text when supplied, else an HTML-derived
		// fallback — the historic behaviour.
		text: job.text || stripHtml(job.html),
		...(job.amp ? { amp: job.amp } : {}),
		...(job.replyTo ? { replyTo: job.replyTo } : {}),
		...(attachments ? { attachments } : {}),
		headers: {
			...callerHeaders,
			...feedbackHeaders,
			'X-Owlat-Message-Id': job.messageId,
			'X-Owlat-Org-Id': job.organizationId,
		},
		// A caller-supplied Message-ID wins; otherwise From-align it (only when the
		// From carries a domain — else the composer derives it from the From addr-spec).
		...(suppliedMessageId !== undefined
			? { messageId: suppliedMessageId }
			: fromDomain
				? { messageIdDomain: fromDomain }
				: {}),
		envelope: { from: verpAddress, to: [job.to] },
	});
}

/**
 * Build the exact wire bytes for a job: compose the structured message (or take
 * the sealed-mail raw MIME verbatim), then DKIM-sign over those bytes.
 *
 * A missing DKIM key ships the message UNSIGNED (recoverable), and a signing
 * failure falls back to the unsigned bytes rather than a corrupt signature.
 *
 * `signed` reports what actually happened to THESE bytes, not what was
 * configured: it is false both when no key exists and when signing threw. The
 * CFBL emission outcome is derived from it (RFC 9477 §3.1.4 — an unsigned
 * message carrying the pair is a header no conforming provider acts on), so
 * "a key is configured" is not a good enough answer.
 */
function buildSignedBytes(
	job: EmailJob,
	dkimConfig: DkimSigningKey | undefined,
	verpAddress: string,
	feedbackHeaders: Record<string, string>
): { bytes: Buffer; signed: boolean } {
	const raw = job.sealedMimeBase64
		? Buffer.from(job.sealedMimeBase64, 'base64')
		: composeStructured(job, verpAddress, feedbackHeaders).raw;
	if (!dkimConfig) return { bytes: raw, signed: false };
	try {
		return { bytes: signMessage(raw, dkimConfig), signed: true };
	} catch (err) {
		logger.error(
			{ err, domain: dkimConfig.domainName, selector: dkimConfig.keySelector },
			'DKIM signing failed; shipping message unsigned'
		);
		return { bytes: raw, signed: false };
	}
}

/**
 * Resolve the DKIM key, the VERP return path and the CFBL pair for this job,
 * then compose and sign it into the one buffer every attempt writes.
 */
export async function prepareSignedMessage(
	job: EmailJob,
	config: MtaConfig,
	redis: Redis
): Promise<SignedMessage> {
	// Scope the DKIM key to the job's owning organization: a domain key bound to
	// another tenant is refused here, so the message ships unsigned rather than
	// carrying a cross-tenant DKIM signature.
	const dkimConfig = await getDkimOptions(redis, job.dkimDomain, job.organizationId);

	// VERP return-path host: a sending domain may register its own bounce host,
	// making the MAIL FROM domain per-sending-domain instead of the single global
	// `RETURN_PATH_DOMAIN`. Keyed by the DKIM signing domain (the sender's own
	// domain). Absent → global fallback, so a domain with no override behaves
	// exactly as before. Attribution stays domain-agnostic: the VERP token's HMAC
	// is computed over the message id + time window (never the host), and the
	// bounce server accepts `bounce+…` at ANY host — so a DSN arriving at the
	// per-domain host still verifies and suppresses the right recipient (see
	// bounce/verp.ts, bounce/server.ts).
	const perDomainReturnPath = await getReturnPathHost(redis, job.dkimDomain.toLowerCase());
	const feedbackHost = perDomainReturnPath ?? config.returnPathDomain;
	const verpAddress = buildVerpAddress(job.messageId, feedbackHost);

	// RFC 9477 CFBL-Address: advertise a SIGNED complaint address on every
	// composed outbound message. It rides the same host as the VERP return path —
	// that host's MX already points at the bounce SMTP server and `fbl+…` is
	// already accepted at RCPT time — so no new DNS, no new listener and, above
	// all, no bilateral enrollment with any mailbox provider.
	//
	// RFC 9477 §3.1.3: when the CFBL host is not the From domain (or a child of
	// it) the message must carry a SECOND DKIM signature aligned with that host,
	// and we sign once. So the pair is emitted only for a sending domain that has
	// registered its own return-path host; on the shared global host we stay
	// silent rather than publish a header every conforming provider ignores.
	// Silence is the DEFAULT branch (most domains use the shared global host), so
	// the outcome is counted: `mta_cfbl_emissions_total{outcome="host_unaligned"}`
	// is how an operator sees that CFBL is off for a domain, and why. Nothing here
	// can fail a send.
	//
	// Sealed mail short-circuits the whole question: its raw bytes ship verbatim
	// and never reach the composer, so no composed header set can ride them.
	// Counting such a send as `emitted` would report a CFBL-Address that is
	// provably not on the wire, so it gets its own bounded label and the builder
	// is not consulted at all.
	//
	// RFC 9477 §3.1 also requires the RFC5322.From domain to be matched by a
	// VALID DKIM signature, and §3.1.4 says a provider "SHALL NOT send a report
	// message" otherwise. A single-domain self-host whose global return-path
	// domain happens to align with From but which has registered no DKIM key
	// sends unsigned, so `dkimConfig` presence gates emission too — otherwise we
	// would publish exactly the inert, provider-discarded header the unaligned
	// branch already refuses to publish.
	const cfbl: CfblHeaderResult = job.sealedMimeBase64
		? { outcome: 'sealed_raw', headers: {} }
		: buildCfblHeaders({
				messageId: job.messageId,
				cfblHost: feedbackHost,
				fromDomain: extractDomainOrNull(job.from) ?? '',
				dkimSigned: dkimConfig !== undefined,
			});

	const { bytes: signedBytes, signed: dkimSigned } = buildSignedBytes(
		job,
		dkimConfig,
		verpAddress,
		cfbl.headers
	);

	// Count the emission only once the bytes exist, and derive the outcome from
	// what actually happened to them. `buildCfblHeaders` was gated on a key being
	// CONFIGURED; signing can still throw, in which case the composer has already
	// embedded the pair and we ship it unsigned. That is precisely the §3.1.4
	// state `no_signature` exists to make visible, so the fallback is relabelled
	// rather than reported as `emitted`. Nothing here can fail a send.
	cfblEmissionsTotal.inc({
		outcome: cfbl.outcome === 'emitted' && !dkimSigned ? 'no_signature' : cfbl.outcome,
	});

	return { signedBytes, verpAddress, dkimDomain: dkimConfig?.domainName };
}
