/**
 * FETCH module tests — body sections, partial, RFC822 aliases, and the
 * implicit \Seen side effect (RFC 3501 §6.4.5 / §7.4.2).
 *
 * The module's `start` is driven directly with a mocked Convex client and
 * a captured `send`. `fetchEnvelopes` returns one stored message whose raw
 * RFC822 bytes (header `Subject: Hi` + body `Hello world`) are served by a
 * stubbed global `fetch`. `storeFlags` is mocked so the \Seen mutation is
 * observable without a live backend.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModule, type FetchArgs } from '../index.js';
import {
	formatBodySection,
	parseBodySectionItem,
	splitHeaderText,
} from '../bodySection.js';
import type { FetchEnvelope } from '../format.js';
import type { CommandDeps, ConnectionState, StartArgs } from '../../types.js';

const RAW = 'Subject: Hi\r\n\r\nHello world';

function envelope(overrides: Partial<FetchEnvelope> = {}): FetchEnvelope {
	return {
		_id: 'm1',
		uid: 7,
		modseq: 1,
		rawSize: Buffer.byteLength(RAW),
		rfc822MessageId: 'mid-1@example.com',
		fromAddress: 'jane@example.com',
		fromName: 'Jane Doe',
		toAddresses: ['bob@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Hi',
		internalDate: Date.UTC(2026, 5, 9, 10, 30, 5),
		flagSeen: false,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
		...overrides,
	};
}

interface Harness {
	/** Every response as raw octets (strings are UTF-8 encoded for capture). */
	sent: Buffer[];
	/** latin1-decoded view of `sent` — one char per octet, for ASCII asserts. */
	lines: string[];
	convex: {
		query: ReturnType<typeof vi.fn>;
		mutation: ReturnType<typeof vi.fn>;
	};
}

function run(
	itemsToken: string,
	{
		readOnly = false,
		msg = envelope(),
		raw = Buffer.from(RAW, 'utf8'),
	}: { readOnly?: boolean; msg?: FetchEnvelope; raw?: Buffer } = {},
): Promise<Harness> {
	const sent: Buffer[] = [];
	// Serve the raw RFC822 bytes as an ArrayBuffer, mirroring the real
	// storage fetch (res.arrayBuffer()) so 8-bit/binary octets survive.
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok: true,
			arrayBuffer: async () =>
				raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
		})),
	);
	const convex = {
		query: vi.fn(async (ref: string) => {
			// Seven messages exist; the fixture message sits at sequence 7
			// (UID 7), so the harness's `set: '7'` resolves to it whether the
			// command is UID-based or not.
			if (ref.endsWith(':listFolderUids')) return [1, 2, 3, 4, 5, 6, 7];
			if (ref.endsWith(':fetchEnvelopes')) return [msg];
			if (ref.endsWith(':fetchRawStorageId'))
				return { storageId: 's1', rawSize: raw.byteLength };
			if (ref.endsWith(':getRawStorageUrl')) return 'https://storage.test/raw';
			return null;
		}),
		mutation: vi.fn(async () => ({
			updated: [{ uid: msg.uid, modseq: msg.modseq + 1, flags: ['\\Seen'] }],
			unchanged: [],
		})),
	};

	const state: ConnectionState = {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@test', userId: 'u1' },
		selected: {
			folderId: 'f1',
			folderName: 'INBOX',
			uidValidity: 1,
			uidNext: 100,
			highestModseq: 1,
			totalCount: 1,
			readOnly,
		},
		clientId: null,
	};

	const startArgs: StartArgs<FetchArgs> = {
		deps: { convex } as unknown as CommandDeps,
		state,
		args: { set: '7', itemsToken, byUid: false },
		tag: 'a001',
		verb: 'FETCH',
		send: (line: string | Buffer) =>
			sent.push(typeof line === 'string' ? Buffer.from(line, 'utf8') : line),
	};

	const session = fetchModule.start(startArgs);
	return session.completion.then(() => ({
		sent,
		lines: sent.map((b) => b.toString('latin1')),
		convex,
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('parseBodySectionItem', () => {
	it('parses BODY[] / BODY[HEADER] / BODY[TEXT] / BODY[1]', () => {
		expect(parseBodySectionItem('BODY[]')).toMatchObject({ section: '', peek: false });
		expect(parseBodySectionItem('BODY[HEADER]')).toMatchObject({ section: 'HEADER' });
		expect(parseBodySectionItem('BODY[TEXT]')).toMatchObject({ section: 'TEXT' });
		expect(parseBodySectionItem('BODY[1]')).toMatchObject({ section: '1' });
	});

	it('parses .PEEK and partial <offset.length>', () => {
		expect(parseBodySectionItem('BODY.PEEK[]')).toMatchObject({ peek: true, section: '' });
		expect(parseBodySectionItem('BODY[]<0.5>')).toMatchObject({
			partial: { offset: 0, length: 5 },
		});
	});

	it('maps the RFC822 aliases', () => {
		expect(parseBodySectionItem('RFC822')).toMatchObject({ section: '', peek: false });
		expect(parseBodySectionItem('RFC822.HEADER')).toMatchObject({ section: 'HEADER', peek: true });
		expect(parseBodySectionItem('RFC822.TEXT')).toMatchObject({ section: 'TEXT', peek: false });
	});

	it('returns null for non-body items', () => {
		expect(parseBodySectionItem('FLAGS')).toBeNull();
		expect(parseBodySectionItem('UID')).toBeNull();
		expect(parseBodySectionItem('RFC822.SIZE')).toBeNull();
	});
});

describe('splitHeaderText', () => {
	it('splits at the blank line, header keeps the terminator', () => {
		const { header, text } = splitHeaderText(Buffer.from(RAW, 'utf8'));
		expect(header.toString('latin1')).toBe('Subject: Hi\r\n\r\n');
		expect(text.toString('latin1')).toBe('Hello world');
	});
});

describe('formatBodySection', () => {
	it('emits a partial with the origin octet (first 5 octets of BODY[])', () => {
		const req = parseBodySectionItem('BODY[]<0.5>')!;
		// RAW begins with the header, so the first 5 octets are "Subje".
		expect(formatBodySection(req, Buffer.from(RAW, 'utf8')).toString('latin1')).toBe(
			'BODY[]<0> {5}\r\nSubje',
		);
	});

	it('emits a TEXT partial scoped to the section, not the whole message', () => {
		const req = parseBodySectionItem('BODY[TEXT]<0.5>')!;
		expect(formatBodySection(req, Buffer.from(RAW, 'utf8')).toString('latin1')).toBe(
			'BODY[TEXT]<0> {5}\r\nHello',
		);
	});

	it('declares {N} as the octet count for a multibyte body, byte-exact', () => {
		// A body with a 4-byte emoji + 2-byte é: 9 chars but 13 octets.
		const body = 'Hi 😀 café';
		const raw = Buffer.from(`Subject: X\r\n\r\n${body}`, 'utf8');
		const req = parseBodySectionItem('BODY[TEXT]')!;
		const out = formatBodySection(req, raw);
		const bodyBytes = Buffer.from(body, 'utf8');
		const header = `BODY[TEXT] {${bodyBytes.length}}\r\n`;
		// {N} must equal the UTF-8 octet length, not the UTF-16 code-unit length.
		expect(bodyBytes.length).toBe(13);
		expect(bodyBytes.length).not.toBe(body.length);
		expect(out.subarray(0, header.length).toString('ascii')).toBe(header);
		// The literal payload is byte-for-byte the original body octets.
		expect(out.subarray(header.length).equals(bodyBytes)).toBe(true);
	});
});

describe('FETCH body sections', () => {
	it('(1) BODY[HEADER] returns only the header block literal', async () => {
		const { lines } = await run('(BODY[HEADER])');
		expect(lines[0]).toContain('BODY[HEADER] {15}\r\nSubject: Hi\r\n\r\n');
		expect(lines[0]).not.toContain('Hello world');
	});

	it('(2) BODY[TEXT] returns only the body text', async () => {
		const { lines } = await run('(BODY[TEXT])');
		expect(lines[0]).toContain('BODY[TEXT] {11}\r\nHello world');
		expect(lines[0]).not.toContain('Subject: Hi');
	});

	it('(3) BODY[]<0.5> returns a 5-octet partial', async () => {
		const { lines } = await run('(BODY[]<0.5>)');
		// The first 5 octets of the whole message ("Subje"), 5-octet literal.
		expect(lines[0]).toContain('BODY[]<0> {5}\r\nSubje');
	});

	it('(4) BODY[] sets \\Seen and the FETCH response carries FLAGS (\\Seen)', async () => {
		const { lines, convex } = await run('(BODY[])');
		// the mutation that adds \Seen ran
		expect(convex.mutation).toHaveBeenCalledTimes(1);
		const mutArgs = convex.mutation.mock.calls[0]![1] as {
			flags: string[];
			mode: string;
		};
		expect(mutArgs.flags).toEqual(['\\Seen']);
		expect(mutArgs.mode).toBe('add');
		// the FETCH itself reports FLAGS (\Seen)
		expect(lines[0]).toMatch(/FLAGS \(\\Seen\)/);
		expect(lines[0]).toContain(`BODY[] {${RAW.length}}\r\n${RAW}`);
	});

	it('(5) BODY.PEEK[] does NOT set \\Seen and emits no FLAGS', async () => {
		const { lines, convex } = await run('(BODY.PEEK[])');
		expect(convex.mutation).not.toHaveBeenCalled();
		expect(lines[0]).not.toContain('FLAGS');
		expect(lines[0]).toContain(`BODY[] {${RAW.length}}\r\n${RAW}`);
	});

	it('read-only mailbox (EXAMINE) never sets \\Seen even on non-PEEK BODY[]', async () => {
		const { lines, convex } = await run('(BODY[])', { readOnly: true });
		expect(convex.mutation).not.toHaveBeenCalled();
		expect(lines[0]).not.toContain('FLAGS');
	});

	it('already-seen message is not re-marked and still reports FLAGS (\\Seen)', async () => {
		const { lines, convex } = await run('(BODY[])', { msg: envelope({ flagSeen: true }) });
		expect(convex.mutation).not.toHaveBeenCalled();
		expect(lines[0]).toMatch(/FLAGS \(\\Seen\)/);
	});

	it('declares {N} = wire octet count and emits byte-exact octets for an 8-bit body', async () => {
		// Header + a body mixing UTF-8 multibyte (é, emoji) and a raw 8-bit
		// latin1 byte 0xE9 that is NOT valid standalone UTF-8 — res.text()
		// would map it to U+FFFD and desync the literal framing.
		const raw = Buffer.concat([
			Buffer.from('Subject: Ünïcödé\r\n\r\n', 'utf8'),
			Buffer.from('café 😀 ', 'utf8'),
			Buffer.from([0xe9]),
		]);
		const { sent } = await run('(BODY.PEEK[])', { raw });
		const line = sent[0]!;

		// Locate the literal header `{N}\r\n` and read back the declared count.
		const text = line.toString('latin1');
		const m = /\{(\d+)\}\r\n/.exec(text);
		expect(m).not.toBeNull();
		const declared = parseInt(m![1]!, 10);
		// The declared octet count is the true byte length of the body...
		expect(declared).toBe(raw.byteLength);
		// ...and it is larger than the UTF-16 code-unit length a naive string
		// literal would have produced (the regression this guards against).
		expect(declared).toBeGreaterThan(raw.toString('utf8').length);

		// The octets after the `{N}\r\n` marker are byte-for-byte the raw body,
		// including the un-decodable 0xE9, followed by the closing paren.
		const markerEnd = m!.index + m![0].length;
		const payload = line.subarray(markerEnd, markerEnd + declared);
		expect(payload.equals(raw)).toBe(true);
		expect(line.subarray(markerEnd + declared).toString('latin1')).toBe(')');
	});
});
