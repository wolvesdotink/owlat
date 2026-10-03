import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Find secret values in a Playwright report before CI uploads it.
 *
 * The E2E workflow uploads `playwright-report/` as an artifact of a public
 * repository, and anyone signed in to GitHub can download it. Log masking does
 * not apply to artifact contents. A secret that reaches a trace (Playwright
 * records the headers of its own HTTP requests) or an attachment would be
 * published with the report.
 *
 * Secrets can sit in three places in an HTML report: plain files (attachments
 * such as `browser-console.txt`), trace archives (`data/*.zip`), and the report
 * data that `index.html` embeds as a base64 zip. All three are searched. A zip
 * that cannot be read counts as a finding: an unreadable archive is one nobody
 * has checked.
 *
 * Findings name the file and the secret's label, never its value.
 */

export interface SecretFinding {
	/** Path relative to the scanned directory, with `!entry` for a zip member. */
	file: string;
	/** The secret's label (its environment variable name), or `unreadable`. */
	label: string;
}

export interface NamedSecret {
	label: string;
	value: string;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MAX_ZIP_DEPTH = 3;
const EMBEDDED_ZIP = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/g;

/** The members of a zip archive, decompressed. Throws on anything it cannot read. */
export function readZipEntries(zip: Buffer): Array<{ name: string; data: Buffer }> {
	let end = -1;
	for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
		if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
			end = at;
			break;
		}
	}
	if (end < 0) throw new Error('no end-of-central-directory record');
	const count = zip.readUInt16LE(end + 10);
	let at = zip.readUInt32LE(end + 16);
	if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 is not supported');

	const entries: Array<{ name: string; data: Buffer }> = [];
	for (let index = 0; index < count; index++) {
		if (zip.readUInt32LE(at) !== CENTRAL_HEADER) throw new Error('bad central directory');
		const method = zip.readUInt16LE(at + 10);
		const compressedSize = zip.readUInt32LE(at + 20);
		const nameLength = zip.readUInt16LE(at + 28);
		const extraLength = zip.readUInt16LE(at + 30);
		const commentLength = zip.readUInt16LE(at + 32);
		const localOffset = zip.readUInt32LE(at + 42);
		const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
		at += 46 + nameLength + extraLength + commentLength;

		if (zip.readUInt32LE(localOffset) !== LOCAL_HEADER)
			throw new Error(`bad local header: ${name}`);
		const dataStart =
			localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
		const raw = zip.subarray(dataStart, dataStart + compressedSize);
		if (method === 0) entries.push({ name, data: raw });
		else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
		else throw new Error(`unsupported compression method ${method}: ${name}`);
	}
	return entries;
}

/** The byte patterns a secret can appear as: raw, and as escaped inside a JSON string. */
function patternsFor(secret: NamedSecret): Buffer[] {
	const raw = Buffer.from(secret.value);
	const escaped = Buffer.from(JSON.stringify(secret.value).slice(1, -1));
	return raw.equals(escaped) ? [raw] : [raw, escaped];
}

function scanBuffer(
	data: Buffer,
	file: string,
	secrets: NamedSecret[],
	findings: SecretFinding[],
	depth: number
): void {
	for (const secret of secrets) {
		if (patternsFor(secret).some((pattern) => data.includes(pattern))) {
			findings.push({ file, label: secret.label });
		}
	}

	const zips: Array<{ file: string; data: Buffer }> = [];
	if (data.subarray(0, 4).equals(ZIP_MAGIC)) zips.push({ file, data });
	if (file.endsWith('.html')) {
		let index = 0;
		for (const match of data.toString('latin1').matchAll(EMBEDDED_ZIP)) {
			zips.push({ file: `${file}#embedded-${index++}`, data: Buffer.from(match[1]!, 'base64') });
		}
	}

	for (const zip of zips) {
		if (depth >= MAX_ZIP_DEPTH) {
			findings.push({ file: zip.file, label: 'unreadable' });
			continue;
		}
		let entries: Array<{ name: string; data: Buffer }>;
		try {
			entries = readZipEntries(zip.data);
		} catch {
			findings.push({ file: zip.file, label: 'unreadable' });
			continue;
		}
		for (const entry of entries) {
			scanBuffer(entry.data, `${zip.file}!${entry.name}`, secrets, findings, depth + 1);
		}
	}
}

function listFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? listFiles(path) : [path];
	});
}

/**
 * Every place under `dir` that holds one of `secrets`, or that could not be
 * read. Empty secrets are ignored. An empty result means the directory is safe
 * to publish as far as these secrets go.
 */
export function findSecretsInReport(dir: string, secrets: NamedSecret[]): SecretFinding[] {
	const present = secrets.filter((secret) => secret.value.length > 0);
	if (present.length === 0) return [];
	const findings: SecretFinding[] = [];
	for (const path of listFiles(dir)) {
		scanBuffer(readFileSync(path), relative(dir, path), present, findings, 0);
	}
	return findings;
}
