/**
 * A gzipped ustar archive of in-memory files, for `owlat-setup support-bundle`.
 *
 * Written here rather than by shelling out to `tar` so the bundle never puts
 * its members on disk first: the collected data lives in memory until the one
 * archive file (or stdout) is written. Regular files only, owner-only mode, one
 * fixed mtime, names checked so an archive member can never point outside the
 * directory it is extracted into.
 */

import { gzipSync } from 'node:zlib';

export interface TarEntry {
	/** Relative path inside the archive, `/`-separated. */
	name: string;
	content: string | Uint8Array;
}

const BLOCK = 512;
/** ustar's name field; longer names would need the prefix field or a pax header. */
const MAX_NAME = 99;
const SAFE_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Whether `name` is a member name this writer accepts. */
export function isSafeTarName(name: string): boolean {
	return (
		name.length <= MAX_NAME &&
		SAFE_NAME.test(name) &&
		!name.split('/').some((part) => part === '.' || part === '..')
	);
}

function writeString(header: Uint8Array, offset: number, length: number, value: string): void {
	const bytes = new TextEncoder().encode(value);
	header.set(bytes.subarray(0, length), offset);
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
	writeString(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function headerFor(name: string, size: number, mtimeSeconds: number): Uint8Array {
	const header = new Uint8Array(BLOCK);
	writeString(header, 0, 100, name);
	writeOctal(header, 100, 8, 0o600);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, size);
	writeOctal(header, 136, 12, mtimeSeconds);
	// The checksum is computed with its own field read as eight spaces.
	header.fill(0x20, 148, 156);
	header[156] = 0x30; // typeflag '0': regular file
	writeString(header, 257, 6, 'ustar\0');
	writeString(header, 263, 2, '00');
	let sum = 0;
	for (const byte of header) sum += byte;
	writeString(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
	return header;
}

/** Build the archive. Throws on a member name {@link isSafeTarName} refuses, or a duplicate. */
export function createTarGz(entries: readonly TarEntry[], mtime: Date): Uint8Array {
	const seen = new Set<string>();
	const mtimeSeconds = Math.max(0, Math.floor(mtime.getTime() / 1000));
	const parts: Uint8Array[] = [];
	for (const entry of entries) {
		if (!isSafeTarName(entry.name)) {
			throw new Error(`Refusing unsafe archive member name: ${JSON.stringify(entry.name)}`);
		}
		if (seen.has(entry.name)) throw new Error(`Duplicate archive member: ${entry.name}`);
		seen.add(entry.name);
		const body =
			typeof entry.content === 'string' ? new TextEncoder().encode(entry.content) : entry.content;
		parts.push(headerFor(entry.name, body.length, mtimeSeconds), body);
		const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
		if (padding > 0) parts.push(new Uint8Array(padding));
	}
	// Two zero blocks end the archive.
	parts.push(new Uint8Array(BLOCK * 2));
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const tar = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		tar.set(part, offset);
		offset += part.length;
	}
	return new Uint8Array(gzipSync(tar));
}
