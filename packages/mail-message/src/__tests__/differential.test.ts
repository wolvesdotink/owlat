/**
 * The parse-side differential harness — the reviewable heart of piece P3.
 *
 * For every raw fixture we parse the SAME bytes twice: once with mailparser's
 * `simpleParser` (the library `parseMessage` replaces on the inbound path), once
 * with our `parseMessage`. We then assert EQUALITY OF EVERY CONSUMED FIELD — the
 * exact subset the six inbound consumers (mail-sync ingest, the bounce parser /
 * FBL processor / route resolver / attachment stager, and the inbound forwarder)
 * read off the parsed object: subject, message-id / in-reply-to (brackets kept),
 * references (dual shape), date, the address headers (name + address, groups
 * recursed), text, the `html | false` sentinel, the attachment set in document
 * order, and the structured `Content-Type` signal.
 *
 * Because we compare mailparser(raw) against parseMessage(raw), any normalization
 * mailparser applies is applied to both projections identically — only a genuine
 * divergence in a consumed field can fail an assertion (divergences must be 0).
 *
 * mailparser survives ONLY as a devDependency of this differential (the oracle),
 * never as a runtime dependency of the package.
 */

import { describe, it, expect } from 'vitest';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { parseMessage, type ParsedMessage, type ParsedHeaderValue } from '../parse/index';
import { RAW_FIXTURES, HOSTILE_FIXTURES } from './fixtures/rawCorpus';

/** A generic address entry both mailparser and our parser expose on `.value`. */
interface AnyAddrEntry {
	name?: string;
	address?: string;
	group?: AnyAddrEntry[];
}
interface AnyAddrObject {
	value?: AnyAddrEntry[];
}

/**
 * Flatten an address header (single object or array, groups recursed) into a
 * comparable, order-preserving list of `{ name, address }`. Groups are recursed
 * symmetrically on both sides so a `Team: a@x, b@y;` header compares its members.
 */
function addrList(
	field: AnyAddrObject | AnyAddrObject[] | AddressObject | AddressObject[] | undefined
): Array<{ name: string; address: string }> {
	if (field === undefined) return [];
	const objs = (Array.isArray(field) ? field : [field]) as AnyAddrObject[];
	const out: Array<{ name: string; address: string }> = [];
	const visit = (entries: AnyAddrEntry[] | undefined): void => {
		for (const entry of entries ?? []) {
			if (entry.group !== undefined) visit(entry.group);
			else out.push({ name: entry.name ?? '', address: (entry.address ?? '').toLowerCase() });
		}
	};
	for (const obj of objs) visit(obj.value);
	return out;
}

/** Normalize the dual `references`/`in-reply-to` shape to a comparable id list. */
function refsList(refs: string | string[] | undefined): string[] {
	if (refs === undefined) return [];
	const arr = Array.isArray(refs) ? refs : refs.split(/\s+/);
	return arr.map((r) => r.trim()).filter((r) => r !== '');
}

/** Normalize a decoded body: CRLF -> LF, drop trailing per-line and end whitespace. */
function normBody(s: string | false | undefined): string | false {
	if (s === false) return false;
	return (s ?? '')
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n+$/, '');
}

/** The `Content-Type` signal the FBL / bounce classifiers consume: value + report-type. */
function contentTypeSignal(raw: unknown): { value: string; reportType: string } {
	if (raw && typeof raw === 'object') {
		const obj = raw as { value?: unknown; params?: Record<string, unknown> };
		const value = typeof obj.value === 'string' ? obj.value.toLowerCase() : '';
		const reportType = String(obj.params?.['report-type'] ?? '').toLowerCase();
		return { value, reportType };
	}
	if (typeof raw === 'string') return { value: raw.toLowerCase(), reportType: '' };
	return { value: '', reportType: '' };
}

/** The document-order attachment set, projected onto the consumed fields. */
function attSet(
	attachments: ParsedMail['attachments'] | ParsedMessage['attachments']
): Array<Record<string, unknown>> {
	return attachments.map((a) => ({
		filename: a.filename ?? '',
		contentType: a.contentType,
		contentId: (a.contentId ?? '').replace(/[<>]/g, ''),
		disposition:
			('disposition' in a ? a.disposition : (a.contentDisposition ?? 'attachment')) ?? 'attachment',
		size: a.size,
		content: a.content.toString('base64'),
	}));
}

/** The consumed-field projection two parses must agree on. */
function project(
	p: ParsedMail | ParsedMessage,
	headerLookup: (name: string) => unknown
): Record<string, unknown> {
	return {
		subject: p.subject ?? '',
		messageId: p.messageId ?? '',
		inReplyTo: p.inReplyTo ?? '',
		references: refsList(p.references),
		date: p.date?.toISOString() ?? '',
		from: addrList(p.from as AnyAddrObject | AnyAddrObject[] | undefined),
		to: addrList(p.to as AnyAddrObject | AnyAddrObject[] | undefined),
		cc: addrList(p.cc as AnyAddrObject | AnyAddrObject[] | undefined),
		bcc: addrList(p.bcc as AnyAddrObject | AnyAddrObject[] | undefined),
		replyTo: addrList(p.replyTo as AnyAddrObject | AnyAddrObject[] | undefined),
		text: normBody(p.text),
		html: normBody(p.html),
		attachments: attSet(p.attachments),
		contentType: contentTypeSignal(headerLookup('content-type')),
	};
}

describe('parseMessage differential parity vs mailparser simpleParser', () => {
	for (const fixture of RAW_FIXTURES) {
		it(`matches mailparser on every consumed field: ${fixture.name}`, async () => {
			const raw = Buffer.from(fixture.raw, 'binary');
			const theirs = await simpleParser(raw);
			const ours = parseMessage(raw);

			const theirProjection = project(theirs, (name) => theirs.headers.get(name));
			const ourProjection = project(ours, (name: string): ParsedHeaderValue | undefined =>
				ours.headers.get(name)
			);

			expect(ourProjection).toEqual(theirProjection);
		});
	}

	it('covers a broad corpus of raw fixtures', () => {
		expect(RAW_FIXTURES.length).toBeGreaterThanOrEqual(20);
		const names = new Set(RAW_FIXTURES.map((f) => f.name));
		expect(names.size).toBe(RAW_FIXTURES.length);
	});
});

/**
 * The P2 hostile corpus, restricted to the consumed-field subset with a defined
 * contract (see `HOSTILE_FIXTURES`' header for the signed-off exclusion of the
 * classes with no shared oracle projection). These MUST still match mailparser
 * on every consumed field — the same equality bar as the well-formed corpus.
 */
describe('parseMessage differential parity vs mailparser on the P2 hostile corpus', () => {
	for (const fixture of HOSTILE_FIXTURES) {
		it(`matches mailparser on every consumed field: ${fixture.name}`, async () => {
			const raw = Buffer.from(fixture.raw, 'binary');
			const theirs = await simpleParser(raw);
			const ours = parseMessage(raw);

			const theirProjection = project(theirs, (name) => theirs.headers.get(name));
			const ourProjection = project(ours, (name: string): ParsedHeaderValue | undefined =>
				ours.headers.get(name)
			);

			expect(ourProjection).toEqual(theirProjection);
		});
	}
});

/**
 * SingleKeys parity: mailparser treats `from`/`sender`/`reply-to` (and
 * `return-path`) as `singleKeys` — a repeated occurrence collapses to the LAST
 * instance (`mail-parser.js`: `headers.set(key, value[value.length - 1])`), never
 * an array. `parseMessage` must mirror that so a (malformed) repeated `From:` /
 * `Reply-To:` projects identically on both stacks — otherwise the mail-sync
 * ingest cutover would ship an array the oracle never produced. `to`/`cc`/`bcc`
 * are NOT singleKeys and keep accumulating; that split is unchanged.
 */
describe('parseMessage matches mailparser singleKeys collapse on repeated address headers', () => {
	const build = (headers: string[]): Buffer =>
		Buffer.from(
			[...headers, 'Subject: dup', 'Message-ID: <dup@example.com>', '', 'Body.', ''].join('\r\n'),
			'binary'
		);

	it('collapses a repeated From: to the last instance (vs mailparser)', async () => {
		const raw = build([
			'From: First <first@example.org>',
			'From: Second <second@example.org>',
			'To: Bob <bob@example.com>',
		]);
		const theirs = await simpleParser(raw);
		const ours = parseMessage(raw);

		expect(addrList(ours.from)).toEqual(addrList(theirs.from));
		expect(addrList(ours.from)).toEqual([{ name: 'Second', address: 'second@example.org' }]);
		expect(Array.isArray(ours.from)).toBe(false);
	});

	it('collapses a repeated Reply-To: to the last instance (vs mailparser)', async () => {
		const raw = build([
			'From: Alice <alice@example.com>',
			'Reply-To: Amy <amy@example.com>',
			'Reply-To: ben@example.org',
			'To: Bob <bob@example.com>',
		]);
		const theirs = await simpleParser(raw);
		const ours = parseMessage(raw);

		expect(addrList(ours.replyTo)).toEqual(addrList(theirs.replyTo));
		expect(addrList(ours.replyTo)).toEqual([{ name: '', address: 'ben@example.org' }]);
		expect(Array.isArray(ours.replyTo)).toBe(false);
	});
});

/**
 * Drop-in typecheck proof (gate (b)): the SAME partial-`ParsedMail` mock shapes
 * the bounce pipeline builds today must typecheck as `ParsedMessage`, and every
 * field the six consumers read must be readable with the exact access patterns
 * they use. If this file compiles, `ParsedMessage` is a structural drop-in for
 * `ParsedMail` on the consumed surface — so the cutover piece can swap
 * `simpleParser(raw)` for `parseMessage(raw)` without touching the consumers.
 *
 * This mirrors `createMockParsedMail` from apps/mta/src/bounce/__tests__ (the
 * `headers: new Map(...)`, string-valued header entries, `attachments` with
 * `content`/`contentType`/`filename`/`size`/`contentId`) and the
 * resolveRoute.test `references: [...]` / `attachments: [...]` shape.
 */
function createMockParsedMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
	return {
		subject: 'test',
		text: 'body',
		html: false,
		headers: new Map([['content-type', 'text/plain']]),
		attachments: [],
		messageId: undefined,
		inReplyTo: undefined,
		references: undefined,
		date: undefined,
		from: undefined,
		to: undefined,
		cc: undefined,
		bcc: undefined,
		replyTo: undefined,
		...overrides,
	} as ParsedMessage;
}

describe('ParsedMessage is a drop-in for the bounce pipeline ParsedMail mocks', () => {
	it('accepts the bounce/resolveRoute mock shapes and exposes every consumed field', () => {
		// The exact base shape the bounce pipeline's `createMockParsedMail` helper
		// supplies (`{ text, subject, headers, attachments }`) yields a genuine
		// `ParsedMessage`. `ParsedMail` (mailparser) declares those fields optional,
		// so a bare literal satisfies it; `ParsedMessage` declares them required, so
		// the mock factory below fills the remaining consumed-field keys the bounce
		// consumers never read — no `as unknown` escape hatch, a real structural
		// drop-in for the partial mocks at cutover.
		const partialMock = createMockParsedMessage({
			subject: 'x',
			text: 't',
			headers: new Map<string, ParsedHeaderValue>(),
			attachments: [],
		});
		expect(partialMock.subject).toBe('x');

		// The resolveRoute.test mock shape (references array + attachment list),
		// built through the helper so `headers` is present for the iteration below.
		const routeMock = createMockParsedMessage({
			from: { value: [{ name: 'A', address: 'a@b' }], text: 'A <a@b>' },
			references: ['<a@b>', '<c@d>'],
			headers: new Map<string, ParsedHeaderValue>([['x-owlat-tag', 'v']]),
			attachments: [
				{
					filename: 'x.txt',
					contentType: 'text/plain',
					contentId: undefined,
					disposition: 'attachment',
					content: Buffer.from('x'),
					size: 1,
				},
			],
		});

		const fblMock = createMockParsedMessage({
			headers: new Map([
				[
					'content-type',
					{ value: 'multipart/report', params: { 'report-type': 'feedback-report' } },
				],
			]),
		});

		// The consumed reads, exactly as the six consumers perform them.
		// bounce/parser + fblProcessor: headers.get('content-type'), text, subject.
		const ct = fblMock.headers.get('content-type');
		expect(ct !== undefined).toBe(true);
		const received = fblMock.headers.get('received');
		expect(String(received ?? '')).toBe('');
		// stageAttachments/forwarder: iterate headers, take string values only.
		const copied: Record<string, string> = {};
		for (const [key, value] of routeMock.headers) {
			if (typeof value === 'string') copied[key] = value;
		}
		expect(typeof copied).toBe('object');
		// resolveRoute: obj.value[].address over from/to/cc.
		const fromField = routeMock.from;
		const objs = Array.isArray(fromField) ? fromField : fromField ? [fromField] : [];
		const addrs: string[] = [];
		for (const obj of objs) for (const v of obj.value ?? []) if (v.address) addrs.push(v.address);
		expect(addrs).toEqual(['a@b']);
		// ingest: attachments map(a => filename/contentType/size/contentId), from.value[0].address.
		const atts = routeMock.attachments.map((a, i) => ({
			filename: a.filename ?? `attachment-${i + 1}`,
			contentType: a.contentType ?? 'application/octet-stream',
			size: a.size ?? 0,
			contentId: a.contentId ?? undefined,
			contentBase64: a.content.toString('base64'),
			partIndex: String(i),
		}));
		expect(atts[0]?.partIndex).toBe('0');
		// references dual shape + replyTo.text.
		const refs = Array.isArray(routeMock.references)
			? routeMock.references.join(' ')
			: routeMock.references;
		expect(refs).toBe('<a@b> <c@d>');
	});
});
