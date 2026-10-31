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
 * extraction. An adapter here is inbound only: it does not borrow the inner
 * half from a bidirectional channel adapter, whose send, health and
 * signature methods would be fictions for an inbound-only source.
 *
 * This lived in `@owlat/channels` until that package was folded away: one
 * module behind a workspace boundary only this folder ever crossed, mirroring
 * the bidirectional adapters that had already moved to
 * `convex/channels/adapters/`.
 */

import { v, type Infer } from 'convex/values';
import { decodeJsonValue, type JsonBody } from '@owlat/worker-protocol/decodeJson';
import { logWarn } from '../../lib/runtimeLog';
import { spamVerdictValidator } from '../../lib/convexValidators';

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
	/**
	 * VERIFIED ARC CHAIN (RFC 8617), the same triple `inbound.mailbox.received`
	 * has always carried. A forwarder breaks the author's DKIM and DMARC fails
	 * for mail that is perfectly legitimate; a chain sealed `cv=pass` by a
	 * forwarder the operator TRUSTS, attesting the original passed, rescues it.
	 * Without these the team inbox saw only the bare `fail` and refused to file
	 * a forwarded message's attachments under the contact who actually sent it.
	 * All optional — an older MTA omits them, and an absent chain rescues
	 * nothing.
	 */
	arcCv: v.optional(v.string()),
	arcSealerDomain: v.optional(v.string()),
	arcAttestsOriginalPass: v.optional(v.boolean()),
	/**
	 * THE MTA'S spam verdict and score, as the authenticated
	 * delivery webhook carried them. Named for their provenance: only the MTA
	 * adapter sets them, never from a header the sender wrote. Recorded on the
	 * row always; they end a Team run only behind the `mtaVerdictTerminal`
	 * routing switch. Absent on an MTA that sends none.
	 */
	mtaSpamVerdict: v.optional(spamVerdictValidator),
	mtaSpamScore: v.optional(v.number()),
});

export type InboundEmailMessage = Infer<typeof inboundEmailMessageValidator>;

/**
 * The MTA's `inbound.received` envelope, checked before a field of it is read.
 *
 * Exported because the route handler (`inbox/inboundWebhookHttp.ts`) decodes
 * the same shape this adapter reads: it forwards `rawBytesBase64`, which is
 * the one field that never becomes part of `InboundEmailMessage` (the bytes
 * are sealed into storage, not carried on the row). Re-declaring it there was
 * how `partIndex` came to be spelled in four places for one wire change.
 *
 * TWO KINDS OF FIELD. The ones `InboundEmailMessage` carries as they are
 * (addresses, subject, bodies, verdict strings, the timestamp) are checked
 * here: the ingest action's validator would refuse a wrong type anyway, one
 * `ctx.runAction` later as a 500, and a 400 that names the path is the same
 * outcome said earlier. The ones a sender influences and this adapter already
 * projects (`headers`, `attachments`, the spam verdict and score, the ARC
 * flag) stay `unknown`: dropping a bad element there keeps the mail, which a
 * refusal would not.
 */
export const mtaInboundWirePayloadValidator = v.object({
	timestamp: v.number(),
	inboundPayload: v.object({
		from: v.string(),
		to: v.string(),
		subject: v.string(),
		textBody: v.optional(v.string()),
		htmlBody: v.optional(v.string()),
		headers: v.optional(v.any()),
		messageId: v.optional(v.string()),
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.string()),
		/** The whole received message, base64 RFC822. Absent on an older MTA. */
		rawBytesBase64: v.optional(v.string()),
		attachments: v.optional(v.any()),
		spfResult: v.optional(v.string()),
		dkimResult: v.optional(v.string()),
		dmarcResult: v.optional(v.string()),
		dmarcPolicy: v.optional(v.string()),
		envelopeFromDomain: v.optional(v.string()),
		dkimSigningDomain: v.optional(v.string()),
		arcCv: v.optional(v.string()),
		arcSealerDomain: v.optional(v.string()),
		arcAttestsOriginalPass: v.optional(v.any()),
		/** The MTA's spam verdict, the same fields the mailbox payload carries. */
		spamScore: v.optional(v.any()),
		spamVerdict: v.optional(v.any()),
	}),
});

type CheckedInboundPayload = Infer<typeof mtaInboundWirePayloadValidator>['inboundPayload'];

/** A decoded envelope. The projected fields are `unknown`, never `any`. */
export interface MtaInboundWirePayload {
	timestamp: number;
	inboundPayload: Omit<
		CheckedInboundPayload,
		'headers' | 'attachments' | 'arcAttestsOriginalPass' | 'spamScore' | 'spamVerdict'
	> & {
		headers?: unknown;
		attachments?: unknown;
		arcAttestsOriginalPass?: unknown;
		spamScore?: unknown;
		spamVerdict?: unknown;
	};
}

/**
 * Check an `inbound.received` envelope. Both routes that carry one (the
 * team-inbox route and the legacy `/webhooks/mta` pipeline) call this, so they
 * refuse the same bodies.
 */
export function decodeMtaInboundWire(raw: unknown): JsonBody<MtaInboundWirePayload> {
	return decodeJsonValue(raw, mtaInboundWirePayloadValidator);
}

const MTA_SPAM_VERDICTS: ReadonlySet<string> = new Set(['ham', 'spam', 'quarantine']);

/**
 * The wire's spam verdict, kept only when it is one the validator knows. A
 * value outside the three is dropped rather than thrown on, for the same
 * reason as `storableHeaders`: a throw here would 500 a delivery the MTA
 * retries into the DLQ.
 */
function mtaSpamVerdictOf(raw: unknown): InboundEmailMessage['mtaSpamVerdict'] {
	return typeof raw === 'string' && MTA_SPAM_VERDICTS.has(raw)
		? (raw as InboundEmailMessage['mtaSpamVerdict'])
		: undefined;
}

function mtaSpamScoreOf(raw: unknown): number | undefined {
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
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
 * The wire's attachment list, reduced to the four fields the canonical shape
 * declares.
 *
 * THE OTHER SENDER-INFLUENCED ARRAY ON THIS WIRE, and it needed the same
 * treatment `storableHeaders` gives the header map. `inboundEmailMessageValidator`
 * spells each element as a closed `v.object`, and Convex REJECTS an unknown
 * field in one — so a single extra key anywhere in the list threw inside the
 * route's `ctx.runAction`, answered 500, and burned the MTA's six retries into
 * the DLQ with nothing stored. `redisKey` is exactly such a key: it is what a
 * pre-#659 MTA put on every attachment element, and the upgraded binary replays
 * its DLQ backlog at this route.
 *
 * So each element is PROJECTED rather than forwarded: the four known fields,
 * type-checked, with anything else dropped. A non-object element is dropped
 * whole; a `size` that is not a number becomes `0` (metadata, and a wrong
 * number is better than losing the mail); a non-string `filename`/`partIndex`
 * simply goes absent, which every reader already handles.
 */
export function storableAttachments(
	raw: unknown,
	messageId: string
): InboundEmailMessage['attachments'] {
	if (!Array.isArray(raw)) return [];
	const out: InboundEmailMessage['attachments'] = [];
	let dropped = 0;
	for (const element of raw) {
		if (!element || typeof element !== 'object' || Array.isArray(element)) {
			dropped += 1;
			continue;
		}
		const att = element as Record<string, unknown>;
		out.push({
			...(typeof att['filename'] === 'string' ? { filename: att['filename'] } : {}),
			contentType:
				typeof att['contentType'] === 'string' ? att['contentType'] : 'application/octet-stream',
			size: typeof att['size'] === 'number' && Number.isFinite(att['size']) ? att['size'] : 0,
			...(typeof att['partIndex'] === 'string' ? { partIndex: att['partIndex'] } : {}),
		});
	}
	if (dropped > 0) {
		logWarn('[Inbound adapter] dropped attachment entries that were not objects', {
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
		const decoded = decodeMtaInboundWire(raw);
		if (!decoded.ok) {
			const { failure } = decoded;
			throw new TypeError(
				`mta inbound.received: ${failure.kind === 'invalid' ? failure.issue : failure.message}`
			);
		}
		const env = decoded.value;
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
			// Sender-influenced elements, projected to the four fields the
			// validator declares — see `storableAttachments`. Defaulted, not
			// asserted: the wire check leaves this list `unknown` on purpose.
			// Refusing a delivery over attachment metadata would send intact
			// mail through the MTA's retries into the DLQ, where nobody looks.
			attachments: storableAttachments(input.attachments, messageId),
			timestamp: env.timestamp,
			spfResult: input.spfResult,
			dkimResult: input.dkimResult,
			dmarcResult: input.dmarcResult,
			dmarcPolicy: input.dmarcPolicy,
			envelopeFromDomain: input.envelopeFromDomain,
			dkimSigningDomain: input.dkimSigningDomain,
			arcCv: input.arcCv,
			arcSealerDomain: input.arcSealerDomain,
			arcAttestsOriginalPass:
				typeof input.arcAttestsOriginalPass === 'boolean'
					? input.arcAttestsOriginalPass
					: undefined,
			// L5: the verdict this HMAC-verified MTA delivery carries — the only
			// trusted source of it on this path.
			mtaSpamVerdict: mtaSpamVerdictOf(input.spamVerdict),
			mtaSpamScore: mtaSpamScoreOf(input.spamScore),
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
