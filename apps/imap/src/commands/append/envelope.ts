/**
 * The envelope and inline bodies of an APPENDed message, read through the same
 * `parseMessage` every other ingest path uses (mail-sync, the MTA, archive
 * import), so charset, date, group-syntax and bounded-work fixes in
 * `@owlat/mail-message` reach APPEND too. The raw .eml stays the source of
 * truth; this only pre-fills the `mailMessages` row.
 */

import { addressFieldList, parseMessage, primaryMailbox } from '@owlat/mail-message';

/**
 * Cap on each inline body. `appendMessage` is a mutation, so it cannot spill a
 * large body to storage the way the delivery pipeline does; 64 KiB matches the
 * pipeline's inline threshold and keeps the row well under Convex's 1 MiB
 * document limit. Longer bodies are truncated, and the raw .eml keeps the rest.
 */
export const APPEND_INLINE_BODY_LIMIT_BYTES = 64 * 1024;

interface AppendAddress {
	address: string;
	/** Decoded display name, absent when the header carries none. */
	name?: string;
}

interface AppendEnvelope {
	/** Bare Message-ID, or a generated `append-…` id when the header is missing. */
	messageId: string;
	/** The first bare Message-ID from In-Reply-To, when present. */
	inReplyTo?: string;
	/** Bare Message-IDs from References, oldest first. */
	references: string[];
	subject: string;
	from: AppendAddress;
	to: AppendAddress[];
	cc: AppendAddress[];
	bcc: AppendAddress[];
	internalDate?: number;
	text?: string;
	html?: string;
}

/**
 * The bracketed msg-ids in an In-Reply-To value, bare. `parseMessage` hands
 * back the raw header, and some clients add a comment or a phrase next to the
 * id, so only `<…>` tokens count.
 */
function messageIdList(value: string | undefined): string[] {
	if (!value) return [];
	const ids: string[] = [];
	for (const match of value.matchAll(/<([^<>\s]+)>/g)) ids.push(match[1]!.toWellFormed());
	return ids;
}

function bareId(id: string): string {
	return id.replace(/[<>]/g, '').trim().toWellFormed();
}

/** A byte-accurate UTF-8 prefix of at most {@link APPEND_INLINE_BODY_LIMIT_BYTES}. */
function capInlineBody(body: string | undefined): string | undefined {
	if (!body) return undefined;
	body = body.toWellFormed();
	if (Buffer.byteLength(body, 'utf-8') <= APPEND_INLINE_BODY_LIMIT_BYTES) return body;
	// A multibyte character cut at the boundary decodes to U+FFFD, harmless for
	// a preview and a search excerpt.
	const prefix = Buffer.from(body, 'utf-8').subarray(0, APPEND_INLINE_BODY_LIMIT_BYTES);
	return new TextDecoder('utf-8').decode(prefix);
}

// Every string below goes into a Convex value, which rejects lone surrogates; a
// decoded header can carry one, so each is made well-formed on the way out.
function toAppendAddress(addr: { address: string; name: string }): AppendAddress {
	const address = addr.address.toWellFormed();
	return addr.name ? { address, name: addr.name.toWellFormed() } : { address };
}

export function appendEnvelope(raw: Buffer): AppendEnvelope {
	const parsed = parseMessage(raw);

	const references = (
		Array.isArray(parsed.references)
			? parsed.references
			: parsed.references
				? [parsed.references]
				: []
	)
		.map(bareId)
		.filter((id) => id !== '');

	const from = primaryMailbox(parsed.from);

	return {
		messageId:
			bareId(parsed.messageId ?? '') ||
			`append-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
		inReplyTo: messageIdList(parsed.inReplyTo)[0],
		references,
		subject: parsed.subject?.toWellFormed() ?? '(no subject)',
		from: from ? toAppendAddress(from) : { address: 'unknown@unknown' },
		to: addressFieldList(parsed.to).map(toAppendAddress),
		cc: addressFieldList(parsed.cc).map(toAppendAddress),
		bcc: addressFieldList(parsed.bcc).map(toAppendAddress),
		internalDate: parsed.date?.getTime(),
		text: capInlineBody(parsed.text),
		html: capInlineBody(parsed.html === false ? undefined : parsed.html),
	};
}
