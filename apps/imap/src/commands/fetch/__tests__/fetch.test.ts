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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
		rawSize: RAW.length,
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
	lines: string[];
	convex: {
		query: ReturnType<typeof vi.fn>;
		mutation: ReturnType<typeof vi.fn>;
	};
}

function run(
	itemsToken: string,
	{ readOnly = false, msg = envelope() }: { readOnly?: boolean; msg?: FetchEnvelope } = {},
): Promise<Harness> {
	const lines: string[] = [];
	const convex = {
		query: vi.fn(async (ref: string) => {
			// Seven messages exist; the fixture message sits at sequence 7
			// (UID 7), so the harness's `set: '7'` resolves to it whether the
			// command is UID-based or not.
			if (ref.endsWith(':listFolderUids')) return [1, 2, 3, 4, 5, 6, 7];
			if (ref.endsWith(':fetchEnvelopes')) return [msg];
			if (ref.endsWith(':fetchRawStorageId')) return { storageId: 's1', rawSize: RAW.length };
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
		send: (line: string) => lines.push(line),
	};

	const session = fetchModule.start(startArgs);
	return session.completion.then(() => ({ lines, convex }));
}

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ ok: true, text: async () => RAW })),
	);
});

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
		expect(splitHeaderText(RAW)).toEqual({ header: 'Subject: Hi\r\n\r\n', text: 'Hello world' });
	});
});

describe('formatBodySection', () => {
	it('emits a partial with the origin octet (first 5 octets of BODY[])', () => {
		const req = parseBodySectionItem('BODY[]<0.5>')!;
		// RAW begins with the header, so the first 5 octets are "Subje".
		expect(formatBodySection(req, RAW)).toBe('BODY[]<0> {5}\r\nSubje');
	});

	it('emits a TEXT partial scoped to the section, not the whole message', () => {
		const req = parseBodySectionItem('BODY[TEXT]<0.5>')!;
		expect(formatBodySection(req, RAW)).toBe('BODY[TEXT]<0> {5}\r\nHello');
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
});
