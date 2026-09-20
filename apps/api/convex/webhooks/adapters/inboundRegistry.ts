/**
 * Inbound channel adapter registry — vendor envelope → canonical inbound mail.
 *
 * A webhook route hands the raw body to the adapter for its source, which
 * normalizes it into the `InboundEmailMessage` that
 * `internal.inbound.receiveMessage` persists, so the persistence layer stays
 * source-agnostic. Adding a source is one adapter plus one entry in `ADAPTERS`.
 *
 * Each adapter owns the whole translation for its source: the vendor envelope
 * (Resend / Postmark / Mailgun all have different shells) and the inner field
 * extraction. Until the D10 honesty pass, the Resend adapter borrowed the inner
 * half from a bidirectional `EmailAdapter` whose other three methods were
 * fictions (a `send` that hard-returned failure, a `healthCheck` that
 * hard-returned healthy, a `validateSignature` that hard-returned true); that
 * class is gone and its one real method is inlined below, unchanged.
 *
 * This lived in `@owlat/channels` until that package was folded away: one
 * module behind a workspace boundary only this folder ever crossed, mirroring
 * the bidirectional adapters that had already moved to
 * `convex/channels/adapters/`.
 */

import { v, type Infer } from 'convex/values';
import { logWarn } from '../../lib/runtimeLog';

/**
 * Canonical inbound email shape consumed by `internal.inbound.receiveMessage`.
 *
 * DECLARED ONCE, AS A CONVEX VALIDATOR. The shape has to exist both as a TS
 * type (the adapters build it) and as an argument validator (the ingest action
 * receives it over `ctx.runAction`), and while those were two hand-kept
 * spellings, adding a field meant editing both and nothing failed if you only
 * edited one. `Infer` makes the type a projection of the validator.
 */
export const inboundEmailMessageValidator = v.object({
	from: v.string(),
	to: v.string(),
	subject: v.string(),
	textBody: v.optional(v.string()),
	htmlBody: v.optional(v.string()),
	headers: v.record(v.string(), v.string()),
	messageId: v.string(),
	inReplyTo: v.optional(v.string()),
	references: v.optional(v.string()),
	/**
	 * Metadata only. The bytes ride the MTA payload's `rawBytesBase64` (the
	 * whole raw message), which the inbound route seals into `_storage` and
	 * re-extracts parts from; this array says which parts are in there.
	 *
	 * `partIndex` is the MIME walk position `extractAttachmentAt` addresses a
	 * part by. Optional: a source that does not walk MIME (Resend) has none,
	 * and mail received before the MTA started sending it has none either, so
	 * a reader falls back to filename matching for those rows.
	 */
	attachments: v.array(
		v.object({
			filename: v.optional(v.string()),
			contentType: v.string(),
			size: v.number(),
			partIndex: v.optional(v.string()),
		})
	),
	/** Timestamp from the webhook envelope (ms since epoch). */
	timestamp: v.number(),
	// RFC 8601 inbound auth verdicts, computed by the MTA at ingest and carried
	// through to `inboundMessages`. All optional: an older MTA (or a disabled
	// check) omits the field, which must render as "unknown" — never "pass".
	spfResult: v.optional(v.string()),
	dkimResult: v.optional(v.string()),
	dmarcResult: v.optional(v.string()),
	dmarcPolicy: v.optional(v.string()),
	/**
	 * DMARC ALIGNMENT INPUTS — the domains SPF and DKIM actually authenticated.
	 * Carried because a pass on its own says nothing about the `From:` a reader
	 * sees: an attacker can DKIM-sign their own mail and still claim to be the
	 * CEO. Attachment capture uses them to decide whether a `dmarcResult` of
	 * `'none'` (a From domain with no published policy) may still be scoped to
	 * the claimed contact. Absent on an older MTA — and an absent domain cannot
	 * align, which fails closed.
	 */
	envelopeFromDomain: v.optional(v.string()),
	dkimSigningDomain: v.optional(v.string()),
});

export type InboundEmailMessage = Infer<typeof inboundEmailMessageValidator>;

/**
 * The MTA's `inbound.received` envelope as it arrives on the wire.
 *
 * Exported because the route handler (`inbox/inboundWebhookHttp.ts`) needs the
 * same shape this adapter casts to: it audits the envelope identifiers and
 * forwards `rawBytesBase64`, which is the one field that never becomes part of
 * `InboundEmailMessage` (the bytes are sealed into storage, not carried on the
 * row). Re-declaring it there was how `partIndex` came to be spelled in four
 * places for one wire change.
 *
 * A CAST OVER WIRE DATA, not a promise: every field is what the sender sent,
 * which is why `parseInbound` defaults rather than asserts.
 */
export interface MtaInboundWirePayload {
	event?: string;
	messageId?: string;
	organizationId?: string;
	message?: string;
	timestamp: number;
	inboundPayload: {
		from: string;
		to: string;
		subject: string;
		textBody?: string;
		htmlBody?: string;
		headers: Record<string, string>;
		date?: string;
		messageId?: string;
		inReplyTo?: string;
		references?: string;
		/** The whole received message, base64 RFC822. Absent on an older MTA. */
		rawBytesBase64?: string;
		/** Exactly the element shape the validator above defines — not a fifth spelling of it. */
		attachments: InboundEmailMessage['attachments'];
		spfResult?: string;
		dkimResult?: string;
		dmarcResult?: string;
		dmarcPolicy?: string;
		envelopeFromDomain?: string;
		dkimSigningDomain?: string;
	};
}

/**
 * Convex's own field-name rule, which a sender-chosen header name can break.
 *
 * `headers` crosses `ctx.runAction` as a record, and Convex serialises action
 * arguments with `convexToJson`, whose `validateObjectField` THROWS for a key
 * that starts with `$`, contains a byte outside printable ASCII, or runs past
 * 1024 characters. `$x: y` is a perfectly legal RFC 5322 field name, and
 * `@owlat/mail-message` lower-cases whatever it finds before the colon without
 * a charset restriction — so one crafted header used to throw inside the
 * route's try/catch, answer 500, and burn the MTA's six retries into the DLQ
 * on a path whose whole invariant is that mail is never dropped. The legacy
 * `/webhooks/mta` route never had this failure only because its dispatcher
 * JSON-stringified the map in-process before any validator saw it.
 *
 * So the ingest boundary is where a header name has to survive the check —
 * here, before the record is built, not four modules later where the only
 * available answer is a 5xx.
 */
const MAX_HEADER_NAME_CHARS = 1024;

function isStorableHeaderName(name: string): boolean {
	if (name.length === 0 || name.length > MAX_HEADER_NAME_CHARS) return false;
	if (name.startsWith('$')) return false;
	for (let i = 0; i < name.length; i += 1) {
		const code = name.charCodeAt(i);
		if (code < 32 || code >= 127) return false;
	}
	return true;
}

/**
 * The wire's header map, reduced to what can actually be stored.
 *
 * DROPS rather than renames: a renamed header is a header nobody looked for,
 * and the values this map feeds (anti-loop detection, threading, the reader's
 * header view) are all keyed by name. A dropped one is logged with its count so
 * the omission is not silent. Non-string values go too — the map is a cast over
 * wire JSON, and `v.record(v.string(), v.string())` rejects an array of
 * `Received:` lines exactly as hard as it rejects a `$` key.
 */
export function storableHeaders(raw: unknown, messageId: string): Record<string, string> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	let dropped = 0;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== 'string' || !isStorableHeaderName(name)) {
			dropped += 1;
			continue;
		}
		out[name] = value;
	}
	if (dropped > 0) {
		logWarn('[Inbound adapter] dropped header fields Convex cannot store', {
			messageId,
			dropped,
		});
	}
	return out;
}

/**
 * Source identifier — the registry key. Only sources with an adapter belong
 * here: a member without one is a lookup that compiles and then throws.
 */
export type InboundSource = 'mta' | 'resend';

/**
 * Inbound channel adapter contract — the whole of it.
 *
 * A source key and one translation function producing the canonical, fully
 * typed `InboundEmailMessage`. There is no outbound half, no health probe and
 * no signature check: sending belongs to the send-provider seam, and verifying
 * an inbound request belongs to the route handler that received it — the
 * sibling modules in this folder — which does it against a real secret before
 * it ever asks this registry to parse.
 */
export interface InboundChannelAdapter {
	source: InboundSource;
	parseInbound(raw: unknown): InboundEmailMessage;
}

/**
 * MTA adapter — owlat-mta service forwards inbound mail via the
 * `inbound.received` event shape parsed by the backend's
 * `webhooks/adapters/mta.ts`.
 */
class MtaInboundAdapter implements InboundChannelAdapter {
	source: InboundSource = 'mta';

	parseInbound(raw: unknown): InboundEmailMessage {
		const env = raw as MtaInboundWirePayload;
		// Named `input` on purpose: check-body-access.sh treats a body-field read
		// off any other receiver as a stored-row read, and this file is the ingest
		// boundary — everything it reads came off the wire, never out of the DB.
		const input = env.inboundPayload;
		const messageId = input.messageId ?? `unknown-${env.timestamp}`;
		return {
			from: input.from,
			to: input.to,
			subject: input.subject,
			textBody: input.textBody,
			htmlBody: input.htmlBody,
			// Sender-controlled keys, reduced to the ones Convex will carry —
			// see `storableHeaders`.
			headers: storableHeaders(input.headers, messageId),
			messageId,
			inReplyTo: input.inReplyTo,
			references: input.references,
			// Defaulted, not asserted. This shape is a cast over wire data, and on
			// the team-inbox route a throw here would 500 a request the MTA reads
			// as retryable — six attempts and then the DLQ, which is mail lost
			// where nobody looks. A payload with no attachment list has no
			// attachments.
			attachments: Array.isArray(input.attachments) ? input.attachments : [],
			timestamp: env.timestamp,
			spfResult: input.spfResult,
			dkimResult: input.dkimResult,
			dmarcResult: input.dmarcResult,
			dmarcPolicy: input.dmarcPolicy,
			envelopeFromDomain: input.envelopeFromDomain,
			dkimSigningDomain: input.dkimSigningDomain,
		};
	}
}

/** Flat inbound-mail payload shape the Resend adapter reads. */
interface ResendInboundPayload {
	from?: string;
	to?: string;
	subject?: string;
	textBody?: string;
	htmlBody?: string;
	messageId?: string;
	timestamp?: number;
	inReplyTo?: string;
	references?: string;
}

/**
 * Stub adapter for Resend inbound webhooks. Resend doesn't ship inbound mail
 * routing today; included so callers can detect "source registered but not
 * implemented" vs "unknown source".
 *
 * The field mapping is the one the deleted `EmailAdapter.parseInbound` applied,
 * inlined verbatim — including that a missing `messageId` falls back to
 * `unknown-<timestamp>` using the ALREADY-DEFAULTED timestamp, so the two
 * fields can never disagree about which clock produced them.
 */
class ResendInboundAdapter implements InboundChannelAdapter {
	source: InboundSource = 'resend';

	parseInbound(raw: unknown): InboundEmailMessage {
		const input = raw as ResendInboundPayload;
		const timestamp = input.timestamp ?? Date.now();
		return {
			from: input.from ?? '',
			to: input.to ?? '',
			subject: input.subject ?? '',
			textBody: input.textBody,
			htmlBody: input.htmlBody,
			headers: {},
			messageId: input.messageId ?? `unknown-${timestamp}`,
			inReplyTo: input.inReplyTo,
			references: input.references,
			attachments: [],
			timestamp,
		};
	}
}

const ADAPTERS: Record<InboundSource, InboundChannelAdapter> = {
	mta: new MtaInboundAdapter(),
	resend: new ResendInboundAdapter(),
};

/** Look up the inbound adapter for a source. Total over `InboundSource`. */
export function getInboundChannelAdapter(source: InboundSource): InboundChannelAdapter {
	return ADAPTERS[source];
}
