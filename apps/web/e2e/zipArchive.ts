import { inflateSync, unzipSync } from 'fflate';

/**
 * Read a zip archive for the report secret scan, refusing anything that is not
 * a plain, self-consistent archive.
 *
 * Extraction is fflate's (`unzipSync`, `inflateSync`). fflate trusts what the
 * archive says about itself, though: it reads as many central-directory records
 * as the end record advertises, keys members by name (a duplicate name hides
 * the earlier member), and inflates into a buffer sized from the declared size
 * (a smaller declared size truncates the member). Any of those would let the
 * scan pass an archive it did not fully read. So the structure is checked here
 * first, and fflate's result is cross-checked against it:
 *
 * - the end-of-central-directory record ends the file exactly (no trailing
 *   bytes), for a single disk, without zip64;
 * - the central directory ends exactly where that record starts, and walking
 *   it yields exactly the advertised number of records;
 * - every member's local header lies inside the archive, agrees with its
 *   central record (name, method), and the members (header, data, data
 *   descriptor) tile the bytes before the central directory with no gap, no
 *   overlap and nothing unreferenced;
 * - names are unique, every member inflates to exactly its declared size, and
 *   fflate's members are the same set with the same bytes.
 *
 * Anything else throws; the scanner counts the archive as unreadable.
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
	if (directoryOffset + directorySize !== end)
		fail('central directory does not meet the end record');

	const members: Member[] = [];
	for (let at = directoryOffset; at < end;) {
		if (readUInt32(zip, at) !== CENTRAL_HEADER) fail('bad central directory record');
		const flags = readUInt16(zip, at + 8);
		const method = readUInt16(zip, at + 10);
		const compressedSize = readUInt32(zip, at + 20);
		const size = readUInt32(zip, at + 24);
		const nameLength = readUInt16(zip, at + 28);
		const extraLength = readUInt16(zip, at + 30);
		const commentLength = readUInt16(zip, at + 32);
		const localOffset = readUInt32(zip, at + 42);
		const nameBytes = zip.subarray(at + 46, at + 46 + nameLength);
		at += 46 + nameLength + extraLength + commentLength;
		if (at > end) fail('central directory record overruns');

		if (localOffset >= directoryOffset) fail('local header outside the member area');
		if (readUInt32(zip, localOffset) !== LOCAL_HEADER) fail('bad local header');
		if (readUInt16(zip, localOffset + 8) !== method) fail('local and central methods disagree');
		const localNameLength = readUInt16(zip, localOffset + 26);
		const localExtraLength = readUInt16(zip, localOffset + 28);
		const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength);
		if (!localName.equals(nameBytes)) fail('local and central names disagree');

		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const dataEnd = dataStart + compressedSize;
		let memberEnd = dataEnd;
		if (flags & DATA_DESCRIPTOR_FLAG) {
			memberEnd += readUInt32(zip, dataEnd) === DATA_DESCRIPTOR ? 16 : 12;
		}
		if (memberEnd > directoryOffset) fail('member overruns the central directory');
		members.push({
			name: decodeName(nameBytes, flags),
			method,
			size,
			localOffset,
			dataStart,
			dataEnd,
			end: memberEnd,
		});
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

/** The members of `zip`, decompressed. Throws on anything it cannot fully account for. */
export function readZipEntries(zip: Buffer): ZipEntry[] {
	const members = readMembers(zip);
	const entries = members.map((member): ZipEntry => {
		const raw = zip.subarray(member.dataStart, member.dataEnd);
		let data: Buffer;
		if (member.method === 0) data = raw;
		else if (member.method === 8) data = Buffer.from(inflateSync(raw));
		else return fail(`unsupported compression method ${member.method}`);
		if (data.length !== member.size) fail('member size does not match its record');
		return { name: member.name, data };
	});

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
