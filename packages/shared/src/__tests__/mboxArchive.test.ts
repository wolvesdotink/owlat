import { describe, expect, it } from 'vitest';
import { MboxSplitter, serializeMboxEntry, type MboxEntry } from '../mboxArchive';

const MESSAGE_ONE = 'From: a@example.com\nSubject: One\n\nBody one.\n';
const MESSAGE_TWO = 'From: b@example.com\nSubject: Two\n\nBody two.\n';

function archiveOf(
	...entries: Array<{ raw: string; address?: string; receivedAt: number }>
): string {
	return entries.map((entry) => serializeMboxEntry(entry.raw, entry)).join('');
}

/** Whole-archive split, the way a caller with the bytes in hand would do it. */
function splitAll(archive: string, startOffset = 0): MboxEntry[] {
	const splitter = new MboxSplitter(startOffset);
	return [...splitter.push(archive), ...splitter.flush()];
}

describe('serializeMboxEntry', () => {
	it('emits a From_ line, the quoted message and a trailing blank line', () => {
		const entry = serializeMboxEntry('Subject: Hi\n\nFrom a friend\n', {
			address: '<who@example.com>',
			receivedAt: Date.UTC(2021, 0, 1),
		});
		expect(entry).toBe(
			'From who@example.com Fri Jan  1 00:00:00 2021\nSubject: Hi\n\n>From a friend\n\n'
		);
	});

	it('writes the timestamp in UTC, not in the exporting user zone', () => {
		expect(serializeMboxEntry('x\n', { receivedAt: Date.UTC(2024, 11, 25, 13, 5, 9) })).toContain(
			'Wed Dec 25 13:05:09 2024\n'
		);
	});

	it('keeps the From_ sender a single bracket-free token', () => {
		expect(serializeMboxEntry('x\n', { address: 'Some One <one@x.io>', receivedAt: 0 })).toContain(
			'From Some '
		);
		expect(serializeMboxEntry('x\n', { address: '<one@x.io>', receivedAt: 0 })).toContain(
			'From one@x.io '
		);
	});

	it('falls back to MAILER-DAEMON when there is no usable address', () => {
		expect(serializeMboxEntry('x\n', { address: '  ', receivedAt: 0 })).toContain(
			'From MAILER-DAEMON '
		);
	});

	it('terminates a message that has no trailing newline', () => {
		const entry = serializeMboxEntry('Subject: Hi\n\nno newline', { receivedAt: 0 });
		expect(entry.endsWith('no newline\n\n')).toBe(true);
	});
});

describe('mboxrd quoting round-trip', () => {
	it('escapes every From-like body line and unescapes exactly one level back', () => {
		const raw = 'Header: v\n\nFrom the top\n>From quoted\n>>From double\nnot From here\n';
		const written = serializeMboxEntry(raw, { receivedAt: 0 });
		expect(written).toContain('\n>From the top\n');
		expect(written).toContain('\n>>From quoted\n');
		expect(written).toContain('\n>>>From double\n');
		expect(splitAll(written)[0]?.raw).toBe(raw);
	});
});

describe('MboxSplitter', () => {
	it('round-trips messages written by serializeMboxEntry', () => {
		const archive = archiveOf(
			{ raw: MESSAGE_ONE, address: 'a@example.com', receivedAt: Date.UTC(2021, 0, 1) },
			{ raw: MESSAGE_TWO, address: 'b@example.com', receivedAt: Date.UTC(2021, 0, 2) }
		);
		const entries = splitAll(archive);
		expect(entries.map((entry) => entry.raw)).toEqual([MESSAGE_ONE, MESSAGE_TWO]);
		expect(entries.map((entry) => entry.envelopeSender)).toEqual([
			'a@example.com',
			'b@example.com',
		]);
	});

	it('keeps a body line that only looks like a separator', () => {
		const raw = 'Subject: Trap\n\nFrom Monday we ship.\n';
		const entries = splitAll(archiveOf({ raw, receivedAt: Date.UTC(2021, 0, 1) }));
		expect(entries).toHaveLength(1);
		expect(entries[0]?.raw).toBe(raw);
	});

	it('splits a Gmail Takeout archive with no blank line before the separator', () => {
		const archive =
			'From 1596...@xxx Mon Jan 01 00:00:00 +0000 2018\n' +
			'Subject: One\n\nBody one.\n' +
			'From 1597...@xxx Tue Jan 02 00:00:00 +0000 2018\n' +
			'Subject: Two\n\nBody two.\n';
		expect(splitAll(archive).map((entry) => entry.raw)).toEqual([
			'Subject: One\n\nBody one.\n',
			'Subject: Two\n\nBody two.\n',
		]);
	});

	it('ignores a preamble before the first separator', () => {
		const entries = splitAll(`garbage\n${serializeMboxEntry(MESSAGE_ONE, { receivedAt: 0 })}`);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.raw).toBe(MESSAGE_ONE);
	});

	it('closes a final message that ends without a newline', () => {
		expect(splitAll('From x@y Mon Jan 01 00:00:00 2018\nSubject: End\n\ntail')[0]?.raw).toBe(
			'Subject: End\n\ntail'
		);
	});

	it('returns nothing for an empty archive', () => {
		expect(splitAll('')).toEqual([]);
	});
});

describe('MboxSplitter byte offsets', () => {
	const archive = archiveOf(
		{ raw: MESSAGE_ONE, address: 'a@example.com', receivedAt: Date.UTC(2021, 0, 1) },
		{ raw: MESSAGE_TWO, address: 'b@example.com', receivedAt: Date.UTC(2021, 0, 2) }
	);

	it('reports the range each entry occupied', () => {
		const entries = splitAll(archive);
		expect(entries[0]?.startOffset).toBe(0);
		expect(entries[1]?.startOffset).toBe(entries[0]?.endOffset);
		expect(entries[1]?.endOffset).toBe(archive.length);
	});

	it('is chunk-boundary independent', () => {
		for (const size of [1, 7, 13, 64]) {
			const splitter = new MboxSplitter();
			const entries: MboxEntry[] = [];
			for (let index = 0; index < archive.length; index += size) {
				entries.push(...splitter.push(archive.slice(index, index + size)));
			}
			entries.push(...splitter.flush());
			expect(entries.map((entry) => entry.raw)).toEqual([MESSAGE_ONE, MESSAGE_TWO]);
			expect(entries.map((entry) => entry.startOffset)).toEqual([0, archive.indexOf('From b@')]);
		}
	});

	it('resumes at a recorded offset and re-reads only what was not committed', () => {
		const first = splitAll(archive)[0];
		const resumeAt = first?.endOffset ?? 0;
		const entries = splitAll(archive.slice(resumeAt), resumeAt);
		expect(entries.map((entry) => entry.raw)).toEqual([MESSAGE_TWO]);
		expect(entries[0]?.startOffset).toBe(resumeAt);
	});

	it('exposes the offset of the entry still being accumulated', () => {
		const splitter = new MboxSplitter();
		const secondStart = archive.indexOf('From b@');
		// A separator line that has not arrived in full cannot close the previous
		// entry, so nothing is committed yet and a resume would restart at 0.
		splitter.push(archive.slice(0, secondStart + 5));
		expect(splitter.pendingOffset).toBe(0);
		splitter.push(archive.slice(secondStart + 5, secondStart + 60));
		expect(splitter.pendingOffset).toBe(secondStart);
	});
});
