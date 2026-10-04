// @vitest-environment node
/**
 * The strict archive reader behind the report secret scan (#1203 review). It
 * must read Playwright's archives as they are, and refuse, by throwing, any
 * archive whose structure does not account for every byte, so the scanner
 * quarantines the report instead of publishing what it could not read.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, readZipEntries } from '../zipArchive';
import { centralDirectory, endRecord, hiddenMemberZip, makeZip } from './zipFixtures';

const SECRET = 'dummy-instance-secret-4f1c';

/** Two deflated members, the dummy secret only in the second. */
const twoMemberZip = () =>
	makeZip({ 'trace.trace': '{"type":"context-options"}\n', 'trace.network': SECRET });

/** Byte offset of the first member's local header fields (makeZip puts it at 0). */
const LOCAL = { flags: 6, crc: 14, compressedSize: 18, size: 22 };
/** Byte offset of the first central record's fields. */
const CENTRAL = { flags: 8, crc: 16, compressedSize: 20, size: 24 };

describe('readZipEntries, archives it reads', () => {
	it('reads deflated and stored members back', () => {
		for (const method of [0, 8] as const) {
			const entries = readZipEntries(makeZip({ a: 'alpha', 'b/c': 'beta' }, method));
			expect(entries.map((entry) => [entry.name, entry.data.toString()])).toEqual([
				['a', 'alpha'],
				['b/c', 'beta'],
			]);
		}
	});

	it.each(['signed', 'unsigned'] as const)(
		'reads members with %s data descriptors, as Playwright writes them',
		(descriptor) => {
			const zip = makeZip({
				'0-trace.trace': { content: 'trace', descriptor },
				'0-trace.network': { content: SECRET, descriptor },
			});
			expect(readZipEntries(zip).map((entry) => entry.data.toString())).toEqual(['trace', SECRET]);
		}
	);

	it('computes CRC-32 as zip records it', () => {
		expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
	});
});

describe('readZipEntries, archives it refuses', () => {
	it.each([false, true])(
		'refuses a compressed span that swallows an unlisted member (descriptors: %s)',
		(descriptors) => {
			expect(() => readZipEntries(hiddenMemberZip(SECRET, descriptors))).toThrow(/malformed zip/);
		}
	);

	it('refuses compressed input left over after the DEFLATE stream', () => {
		const raw = Buffer.from('clean');
		const span = Buffer.concat([deflateRawSync(raw), Buffer.from('leftover')]);
		// A member whose headers all agree on the padded span.
		const zip = makeZip({ 'clean.txt': raw }, 0);
		const stored = Buffer.concat([zip.subarray(0, 39), span, zip.subarray(39 + raw.length)]);
		const delta = span.length - raw.length;
		const end = endRecord(stored);
		stored.writeUInt32LE(stored.readUInt32LE(end + 16) + delta, end + 16);
		const central = centralDirectory(stored);
		for (const at of [8, central + 10]) stored.writeUInt16LE(8, at);
		for (const at of [LOCAL.compressedSize, central + CENTRAL.compressedSize]) {
			stored.writeUInt32LE(span.length, at);
		}
		expect(() => readZipEntries(stored)).toThrow(/compressed span holds more/);
	});

	it.each([
		['local and central flags that disagree', LOCAL.flags, 0x800, /flags disagree/],
		['a local CRC that disagrees', LOCAL.crc, 1, /disagree/],
		['a local compressed size that disagrees', LOCAL.compressedSize, 1, /disagree/],
		['a local size that disagrees', LOCAL.size, 1, /disagree/],
	])('refuses %s', (_case, at, value, message) => {
		const zip = twoMemberZip();
		if (at === LOCAL.flags) zip.writeUInt16LE(value, at);
		else zip.writeUInt32LE(value, at);
		expect(() => readZipEntries(zip)).toThrow(message);
	});

	it('refuses a member whose bytes do not match the recorded CRC', () => {
		const zip = twoMemberZip();
		for (const at of [LOCAL.crc, centralDirectory(zip) + CENTRAL.crc]) zip.writeUInt32LE(1, at);
		expect(() => readZipEntries(zip)).toThrow(/CRC does not match/);
	});

	it('refuses a stored member whose span is not its size', () => {
		const zip = makeZip({ a: 'alpha' }, 0);
		for (const at of [LOCAL.size, centralDirectory(zip) + CENTRAL.size]) zip.writeUInt32LE(4, at);
		expect(() => readZipEntries(zip)).toThrow(/size does not match/);
	});

	it.each(['crc', 'compressedSize', 'size'] as const)(
		'refuses a data descriptor whose %s disagrees with the central record',
		(field) => {
			const zip = makeZip({ a: { content: 'alpha', descriptor: 'signed' } });
			const descriptor = centralDirectory(zip) - 16;
			const at = descriptor + { crc: 4, compressedSize: 8, size: 12 }[field];
			zip.writeUInt32LE(zip.readUInt32LE(at) + 1, at);
			expect(() => readZipEntries(zip)).toThrow(/data descriptor disagrees/);
		}
	);

	it.each([
		[
			'a central directory size that stops short',
			(zip: Buffer) => {
				const at = endRecord(zip) + 12;
				zip.writeUInt32LE(zip.readUInt32LE(at) - 1, at);
			},
		],
		[
			'a central directory offset that skips a record',
			(zip: Buffer) => {
				const at = endRecord(zip) + 16;
				zip.writeUInt32LE(zip.readUInt32LE(at) + 1, at);
			},
		],
		[
			'a declared size smaller than the member',
			(zip: Buffer) => zip.writeUInt32LE(4, centralDirectory(zip) + CENTRAL.size),
		],
		['a local name that disagrees with its central record', (zip: Buffer) => zip.write('X', 30)],
	])('refuses %s', (_case, corrupt) => {
		const zip = twoMemberZip();
		corrupt(zip);
		expect(() => readZipEntries(zip)).toThrow(/malformed zip/);
	});

	it('refuses bytes no member accounts for', () => {
		const padded = Buffer.concat([Buffer.from('padding!'), twoMemberZip()]);
		// Shift every offset so the structure still points at the right records.
		const end = endRecord(padded);
		padded.writeUInt32LE(padded.readUInt32LE(end + 16) + 8, end + 16);
		let at = centralDirectory(padded);
		while (at < end) {
			padded.writeUInt32LE(padded.readUInt32LE(at + 42) + 8, at + 42);
			at +=
				46 +
				padded.readUInt16LE(at + 28) +
				padded.readUInt16LE(at + 30) +
				padded.readUInt16LE(at + 32);
		}
		expect(() => readZipEntries(padded)).toThrow(/unreferenced|gap/);
	});

	it('refuses trailing bytes after the end record', () => {
		expect(() => readZipEntries(Buffer.concat([twoMemberZip(), Buffer.from('tail')]))).toThrow(
			/malformed zip/
		);
	});

	it('refuses two members with the same name', () => {
		const zip = makeZip({ a: 'first', b: SECRET });
		// Rename the second member to `a` in both its headers.
		const second = centralDirectory(zip) + 46 + 1;
		zip.write('a', second + 46);
		zip.write('a', zip.readUInt32LE(second + 42) + 30);
		expect(() => readZipEntries(zip)).toThrow(/duplicate/);
	});
});
