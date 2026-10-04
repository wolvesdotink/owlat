import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../zipArchive';

/** One member, when a test needs more than its content. */
export interface ZipMemberSpec {
	content: string | Buffer;
	/** Store the CRC and sizes after the data, as streaming writers (Playwright's) do. */
	descriptor?: 'signed' | 'unsigned';
}

/**
 * A well-formed zip archive in the layout Playwright writes: local headers,
 * then the central directory, then the end record, with real CRCs.
 */
export function makeZip(
	files: Record<string, string | Buffer | ZipMemberSpec>,
	method: 0 | 8 = 8
): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, file] of Object.entries(files)) {
		const spec: ZipMemberSpec =
			typeof file === 'string' || Buffer.isBuffer(file) ? { content: file } : file;
		const raw = Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content);
		const data = method === 8 ? deflateRawSync(raw) : raw;
		const nameBytes = Buffer.from(name);
		const crc = crc32(raw);
		const flags = spec.descriptor ? 0x8 : 0;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		if (!spec.descriptor) {
			local.writeUInt32LE(crc, 14);
			local.writeUInt32LE(data.length, 18);
			local.writeUInt32LE(raw.length, 22);
		}
		local.writeUInt16LE(nameBytes.length, 26);

		let descriptor = Buffer.alloc(0);
		if (spec.descriptor) {
			const fields = Buffer.alloc(12);
			fields.writeUInt32LE(crc, 0);
			fields.writeUInt32LE(data.length, 4);
			fields.writeUInt32LE(raw.length, 8);
			const signature = Buffer.alloc(4);
			signature.writeUInt32LE(0x08074b50, 0);
			descriptor = spec.descriptor === 'signed' ? Buffer.concat([signature, fields]) : fields;
		}
		locals.push(local, nameBytes, data, descriptor);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);

		offset += local.length + nameBytes.length + data.length + descriptor.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

/** Offset of the end record in an archive `makeZip` built (it writes no comment). */
export const endRecord = (zip: Buffer) => zip.length - 22;

/** Offset of the central directory, read from the end record. */
export const centralDirectory = (zip: Buffer) => zip.readUInt32LE(endRecord(zip) + 16);

/**
 * The #1203 round-4 review archive: one central record, `clean.txt`, whose
 * declared compressed span also covers a second, unlisted local member holding
 * `secret`. DEFLATE stops at the end of `clean.txt`'s stream and ignores the
 * rest, and every count and offset still adds up; `zip -FF` recovers the hidden
 * member. With `descriptors`, both members defer their CRC and sizes to a
 * signed data descriptor.
 */
export function hiddenMemberZip(secret: string, descriptors: boolean): Buffer {
	const local = (name: string, content: string) => {
		const nameBytes = Buffer.from(name);
		const raw = Buffer.from(content);
		const data = deflateRawSync(raw);
		const crc = crc32(raw);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(descriptors ? 0x8 : 0, 6);
		header.writeUInt16LE(8, 8);
		if (!descriptors) {
			header.writeUInt32LE(crc, 14);
			header.writeUInt32LE(data.length, 18);
			header.writeUInt32LE(raw.length, 22);
		}
		header.writeUInt16LE(nameBytes.length, 26);
		const descriptor = Buffer.alloc(descriptors ? 16 : 0);
		if (descriptors) {
			descriptor.writeUInt32LE(0x08074b50, 0);
			descriptor.writeUInt32LE(crc, 4);
			descriptor.writeUInt32LE(data.length, 8);
			descriptor.writeUInt32LE(raw.length, 12);
		}
		return { bytes: Buffer.concat([header, nameBytes, data, descriptor]), data, crc };
	};

	const first = local('clean.txt', 'clean');
	const second = local('trace.network', secret);
	const name = Buffer.from('clean.txt');
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(descriptors ? 0x8 : 0, 8);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(first.crc, 16);
	central.writeUInt32LE(first.data.length + second.bytes.length, 20);
	central.writeUInt32LE(5, 24);
	central.writeUInt16LE(name.length, 28);
	const directory = Buffer.concat([central, name]);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(first.bytes.length + second.bytes.length, 16);
	return Buffer.concat([first.bytes, second.bytes, directory, end]);
}
