import { inflateRawSync, type ZlibOptions } from 'node:zlib';
import { unzipSync } from 'fflate';

/**
 * Read a zip archive for the report secret scan, refusing anything that is not
 * a plain, self-consistent archive.
 *
 * Threat model: the inputs are the archives Playwright writes into its own
 * report (trace zips, the report data embedded in index.html), not uploads from
 * an adversary. What this guards against is a secret slipping into the public
 * report unseen because the archive holding it has a shape this reader does not
 * expect. So it fails closed: any structural inconsistency throws, the scanner
 * counts the archive as unreadable, and the whole report is quarantined rather
 * than published. A strange but harmless archive costs one report; a lenient
 * reader could cost the secret.
 *
 * fflate's `unzipSync` alone trusts what the archive says about itself: the
 * advertised record count, a name-keyed member map (a duplicate name hides the
 * earlier member), an output buffer sized from the declared size. DEFLATE
 * itself stops at the end of its stream and ignores whatever follows, so a
 * declared compressed span can swallow a second member. The checks:
 *
 * - the end-of-central-directory record ends the file exactly (no trailing
 *   bytes), for a single disk, without zip64;
 * - the central directory ends exactly where that record starts, and walking
 *   it yields exactly the advertised number of records;
 * - each local header lies inside the archive and agrees with its central
 *   record: name, method, general-purpose flags (UTF-8 bit included), and, when
 *   there is no data descriptor, CRC and both sizes; a data descriptor (with or
 *   without its signature) must agree with the central record too;
 * - the members (header, data, data descriptor) tile the bytes before the
 *   central directory with no gap, no overlap and nothing unreferenced;
 * - a deflated member's stream consumes exactly its declared compressed span
 *   (zlib reports the input it used), a stored member's span is exactly its
 *   size, and every member's output has the declared size and CRC-32;
 * - names are unique, and fflate's own extraction has the same members with
 *   the same bytes.
 *
 * The scanner also searches the raw archive bytes, whatever this decides.
 */

export interface ZipEntry {
	name: string;
	data: Buffer;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const DATA_DESCRIPTOR = 0x08074b50;
const END_RECORD_SIZE = 22;
const UTF8_NAME_FLAG = 0x800;
const DATA_DESCRIPTOR_FLAG = 0x8;

interface Member {
	name: string;
	method: number;
	crc: number;
	compressedSize: number;
	size: number;
	localOffset: number;
	dataStart: number;
	dataEnd: number;
	/** First byte after the member: its data, plus a data descriptor if it has one. */
	end: number;
}

function fail(reason: string): never {
	throw new Error(`malformed zip: ${reason}`);
}

function readUInt16(zip: Buffer, at: number): number {
	if (at < 0 || at + 2 > zip.length) fail('read past the end');
	return zip.readUInt16LE(at);
}

function readUInt32(zip: Buffer, at: number): number {
	if (at < 0 || at + 4 > zip.length) fail('read past the end');
	return zip.readUInt32LE(at);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
	let value = byte;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

/** CRC-32 as zip records it. */
export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** `inflateRawSync` with `info`, which @types/node does not overload. */
const inflateRawWithInfo = inflateRawSync as unknown as (
	data: Buffer,
	options: ZlibOptions & { info: true }
) => { buffer: Buffer; engine: { bytesWritten: number } };

/** The end record whose comment runs exactly to the end of the file. */
function findEndRecord(zip: Buffer): number {
	const lowest = Math.max(0, zip.length - END_RECORD_SIZE - 0xffff);
	for (let at = zip.length - END_RECORD_SIZE; at >= lowest; at--) {
		if (
			zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY &&
			at + END_RECORD_SIZE + zip.readUInt16LE(at + 20) === zip.length
		) {
			return at;
		}
	}
	return fail('no end-of-central-directory record that ends the file');
}

function decodeName(bytes: Buffer, flags: number): string {
	return bytes.toString(flags & UTF8_NAME_FLAG ? 'utf8' : 'latin1');
}

/** CRC and sizes in a data descriptor at `at`, and how long the descriptor is. */
function readDataDescriptor(zip: Buffer, at: number) {
	const signed = readUInt32(zip, at) === DATA_DESCRIPTOR;
	const fields = signed ? at + 4 : at;
	return {
		crc: readUInt32(zip, fields),
		compressedSize: readUInt32(zip, fields + 4),
		size: readUInt32(zip, fields + 8),
		length: signed ? 16 : 12,
	};
}

function readMember(zip: Buffer, at: number, directoryOffset: number): [Member, number] {
	if (readUInt32(zip, at) !== CENTRAL_HEADER) fail('bad central directory record');
	const flags = readUInt16(zip, at + 8);
	const method = readUInt16(zip, at + 10);
	const crc = readUInt32(zip, at + 16);
	const compressedSize = readUInt32(zip, at + 20);
	const size = readUInt32(zip, at + 24);
	const nameLength = readUInt16(zip, at + 28);
	const extraLength = readUInt16(zip, at + 30);
	const commentLength = readUInt16(zip, at + 32);
	const localOffset = readUInt32(zip, at + 42);
	const nameBytes = zip.subarray(at + 46, at + 46 + nameLength);
	const next = at + 46 + nameLength + extraLength + commentLength;

	if (localOffset >= directoryOffset) fail('local header outside the member area');
	if (readUInt32(zip, localOffset) !== LOCAL_HEADER) fail('bad local header');
	if (readUInt16(zip, localOffset + 6) !== flags) fail('local and central flags disagree');
	if (readUInt16(zip, localOffset + 8) !== method) fail('local and central methods disagree');
	const localNameLength = readUInt16(zip, localOffset + 26);
	const localExtraLength = readUInt16(zip, localOffset + 28);
	const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength);
	if (!localName.equals(nameBytes)) fail('local and central names disagree');

	const dataStart = localOffset + 30 + localNameLength + localExtraLength;
	const dataEnd = dataStart + compressedSize;
	let end = dataEnd;
	const local = {
		crc: readUInt32(zip, localOffset + 14),
		compressedSize: readUInt32(zip, localOffset + 18),
		size: readUInt32(zip, localOffset + 22),
	};
	if (flags & DATA_DESCRIPTOR_FLAG) {
		// The local fields are zero (deferred to the descriptor) or already right.
		for (const field of ['crc', 'compressedSize', 'size'] as const) {
			const expected = { crc, compressedSize, size }[field];
			if (local[field] !== 0 && local[field] !== expected) fail(`local ${field} disagrees`);
		}
		const descriptor = readDataDescriptor(zip, dataEnd);
		if (
			descriptor.crc !== crc ||
			descriptor.compressedSize !== compressedSize ||
			descriptor.size !== size
		) {
			fail('data descriptor disagrees with the central record');
		}
		end += descriptor.length;
	} else if (local.crc !== crc || local.compressedSize !== compressedSize || local.size !== size) {
		fail('local and central sizes or CRC disagree');
	}
	if (end > directoryOffset) fail('member overruns the central directory');

	const member: Member = {
		name: decodeName(nameBytes, flags),
		method,
		crc,
		compressedSize,
		size,
		localOffset,
		dataStart,
		dataEnd,
		end,
	};
	return [member, next];
}

function readMembers(zip: Buffer): Member[] {
	const end = findEndRecord(zip);
	if (readUInt16(zip, end + 4) !== 0 || readUInt16(zip, end + 6) !== 0) fail('multi-disk');
	const count = readUInt16(zip, end + 10);
	if (readUInt16(zip, end + 8) !== count) fail('entry counts disagree');
	const directorySize = readUInt32(zip, end + 12);
	const directoryOffset = readUInt32(zip, end + 16);
	if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
		fail('zip64 is not supported');
	}
	if (directoryOffset + directorySize !== end) {
		fail('central directory does not meet the end record');
	}

	const members: Member[] = [];
	for (let at = directoryOffset; at < end;) {
		const [member, next] = readMember(zip, at, directoryOffset);
		if (next > end) fail('central directory record overruns');
		members.push(member);
		at = next;
	}
	if (members.length !== count) fail('advertised entry count does not match the directory');

	// The members must account for every byte before the central directory.
	let covered = 0;
	for (const member of [...members].sort((a, b) => a.localOffset - b.localOffset)) {
		if (member.localOffset !== covered) fail('gap or overlap between members');
		covered = member.end;
	}
	if (covered !== directoryOffset) fail('unreferenced bytes before the central directory');
	if (new Set(members.map((member) => member.name)).size !== members.length) {
		fail('duplicate member name');
	}
	return members;
}

/** A member's bytes, decompressed, after checking they fill exactly its declared span. */
function extract(zip: Buffer, member: Member): Buffer {
	const span = zip.subarray(member.dataStart, member.dataEnd);
	let data: Buffer;
	if (member.method === 0) {
		data = span;
	} else if (member.method === 8) {
		let inflated: ReturnType<typeof inflateRawWithInfo>;
		try {
			inflated = inflateRawWithInfo(span, { info: true });
		} catch {
			return fail('member does not inflate');
		}
		// DEFLATE stops at the end of its stream; anything after it in the span
		// would be bytes no member accounts for.
		if (inflated.engine.bytesWritten !== span.length) {
			fail('compressed span holds more than the member');
		}
		data = inflated.buffer;
	} else {
		return fail(`unsupported compression method ${member.method}`);
	}
	if (data.length !== member.size) fail('member size does not match its record');
	if (crc32(data) !== member.crc) fail('member CRC does not match its record');
	return data;
}

/** The members of `zip`, decompressed. Throws on anything it cannot fully account for. */
export function readZipEntries(zip: Buffer): ZipEntry[] {
	const entries = readMembers(zip).map((member) => ({
		name: member.name,
		data: extract(zip, member),
	}));

	let extracted: Record<string, Uint8Array>;
	try {
		extracted = unzipSync(zip);
	} catch {
		return fail('fflate could not read it');
	}
	if (Object.keys(extracted).length !== entries.length) fail('fflate saw a different member set');
	for (const entry of entries) {
		const theirs = Object.hasOwn(extracted, entry.name) ? extracted[entry.name] : undefined;
		if (!theirs || !entry.data.equals(theirs)) fail('fflate read a member differently');
	}
	return entries;
}
