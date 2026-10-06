/**
 * Run by `forwardMemory.test.ts` in separate Node processes.
 *
 *   write <input> <dir> <sealed|plain>  write the message, sealed at rest or not
 *   read <dir> <sealed|plain>           read it as `fulfil` does, print the peak
 *
 * Writing is its own process so that building (and sealing) the input never
 * counts towards the read's peak. The read is `fulfil`'s path with every copy
 * it makes: a message over `MAX_FORWARD_RAW_BYTES` is not read; otherwise the
 * stored blob stays in memory as `storage.get` holds it (modelled by holding
 * the file's bytes), `readSealedBlobBytesStreaming` unseals it as it streams,
 * `locateForwardedParts` finds the parts, and each part within the per-file
 * limit is decoded and handed to a `Blob` the way `storage.store` receives it,
 * one at a time. Nothing forces a collection in between. The process's peak
 * resident memory is printed as JSON.
 */
import { appendFileSync, openAsBlob, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_FORWARD_RAW_BYTES } from '@owlat/shared/attachments';
import { locateForwardedParts } from '@owlat/shared/mailMime';
import type { Id } from '../../_generated/dataModel';
import { sealBytesAtRest } from '../../lib/atRestBodies';
import { readSealedBlobBytesStreaming } from '../../lib/sealedBlobStream';

const PROBE_SECRET = 'forward-memory-probe-secret';
const MiB = 1024 * 1024;

/** Write `head`, then `unit` repeated to fill `size` bytes, then `tail`. */
function writeRepeated(
	path: string,
	size: number,
	head: string,
	unit: string,
	tail: string
): number {
	const count = Math.max(0, Math.floor((size - head.length - tail.length) / unit.length));
	writeFileSync(path, head);
	const batch = Math.max(1, Math.floor((1024 * 1024) / unit.length));
	const chunk = unit.repeat(batch);
	let written = 0;
	for (; written + batch <= count; written += batch) appendFileSync(path, chunk);
	appendFileSync(path, unit.repeat(count - written) + tail);
	return head.length + count * unit.length + tail.length;
}

const crlf = (...lines: string[]) => lines.join('\r\n');

/** A message whose one attachment body is `unit` repeated, `size` bytes in all. */
function attachment(encoding: string, unit: string, size = MAX_FORWARD_RAW_BYTES - 4096) {
	return (path: string) =>
		writeRepeated(
			path,
			size,
			crlf(
				'MIME-Version: 1.0',
				'Content-Type: multipart/mixed; boundary="b"',
				'',
				'--b',
				'Content-Type: text/plain',
				'',
				'See attached.',
				'--b',
				'Content-Type: application/octet-stream; name="big.bin"',
				'Content-Disposition: attachment; filename="big.bin"',
				`Content-Transfer-Encoding: ${encoding}`,
				'',
				''
			),
			unit,
			'\r\n--b--\r\n'
		);
}

/** Many parts, each a header block of `headerLines` tiny headers and a small file. */
function partsWithHeaders(headerLines: number) {
	const part = crlf(
		'--b',
		...Array.from({ length: headerLines }, (_, i) => `X-H${i}: v`),
		'Content-Disposition: attachment; filename="p.txt"',
		'',
		'body',
		''
	);
	return (path: string) =>
		writeRepeated(
			path,
			MAX_FORWARD_RAW_BYTES - 4096,
			crlf('Content-Type: multipart/mixed; boundary="b"', '', ''),
			part,
			'--b--\r\n'
		);
}

/** A part nested `depth` multiparts deep holding a large attachment. */
function nestedAttachment(depth: number) {
	return (path: string) => {
		const open: string[] = [];
		const close: string[] = [];
		for (let i = 0; i < depth; i++) {
			open.push(`Content-Type: multipart/mixed; boundary="n${i}"`, '', `--n${i}`);
			close.unshift(`--n${i}--`);
		}
		return writeRepeated(
			path,
			MAX_FORWARD_RAW_BYTES - 4096,
			crlf(
				...open,
				'Content-Disposition: attachment; filename="deep.bin"',
				'Content-Transfer-Encoding: base64',
				'',
				''
			),
			`${'QUJD'.repeat(19)}\r\n`,
			crlf('', ...close, '')
		);
	};
}

const INPUTS: Record<string, (path: string) => number> = {
	// Sol's round-6 shapes, and one decoded and stored just under the per-file limit.
	'base64-64MiB': attachment('base64', `${'QUJD'.repeat(19)}\r\n`, 64 * MiB),
	'base64-50MiB': attachment('base64', `${'QUJD'.repeat(19)}\r\n`),
	'base64-33MiB': attachment('base64', `${'QUJD'.repeat(19)}\r\n`, 33 * MiB),
	'qp-8MiB': attachment('quoted-printable', `${'=41'.repeat(25)}\r\n`, 8 * MiB),
	// Quoted-printable: escapes with soft breaks, soft breaks only, a mix,
	// invalid escapes, and `=` up to the end of the body.
	'qp-escapes-soft-breaks': attachment('quoted-printable', `${'=41'.repeat(25)}=\r\n`),
	'qp-soft-breaks-only': attachment('quoted-printable', '=\r\n'),
	'qp-mixed': attachment('quoted-printable', 'plain =3D text=41=\r\n=0D=0A tail \r\n'),
	'qp-invalid-escapes': attachment('quoted-printable', `${'=G1=Z'.repeat(15)}=\r\n`),
	'qp-equals-to-the-end': attachment('quoted-printable', '='),
	// base64: mostly whitespace, mostly garbage, no padding.
	'base64-whitespace': attachment('base64', 'QUJD \t \t \t \t \t \r\n'),
	'base64-garbage': attachment('base64', '!!@@##$$%%^^QUJD&&**(())\r\n'),
	'base64-no-padding': attachment('base64', 'QUJDRA\r\n'),
	// Header floods.
	'headers-no-separator': (path) =>
		writeRepeated(path, MAX_FORWARD_RAW_BYTES - 4096, '', 'X: a\r\n', ''),
	'headers-then-body': (path) =>
		writeRepeated(path, MAX_FORWARD_RAW_BYTES - 4096, '', 'X: a\r\n', '\r\nbody\r\n'),
	'header-folded-long': (path) =>
		writeRepeated(
			path,
			MAX_FORWARD_RAW_BYTES - 4096,
			'X-Long: a\r\n',
			' folded\r\n',
			'\r\nbody\r\n'
		),
	'parts-many-tiny-headers': partsWithHeaders(2000),
	'parts-tiny-with-big-headers': partsWithHeaders(6000),
	// Lines and boundaries.
	'long-line-no-crlf': attachment('7bit', 'a'),
	'nested-depth-100': nestedAttachment(100),
	'boundary-text-in-body': attachment('7bit', '--bz not a delimiter\r\n--b-- \tx\r\nx--b\r\n'),
};

const name = process.argv[2] ?? '';
const [mode, ...args] = process.argv.slice(2);

if (mode === 'write') {
	const [name = '', dir = '', sealing = 'plain'] = args;
	const write = INPUTS[name];
	if (!write) throw new Error(`unknown input ${name}`);
	const plain = join(dir, 'message.eml');
	write(plain);
	if (sealing === 'sealed') {
		writeFileSync(
			join(dir, 'message.sealed'),
			await sealBytesAtRest(PROBE_SECRET, new Uint8Array(readFileSync(plain)))
		);
	}
} else if (mode === 'read') {
	const [dir = '', sealing = 'plain'] = args;
	const path = join(dir, sealing === 'sealed' ? 'message.sealed' : 'message.eml');
	const size = statSync(path).size;
	(globalThis as { gc?: () => void }).gc?.();
	const baseline = process.memoryUsage().rss;
	let held: Uint8Array | null = null;
	let raw: Uint8Array | null = null;
	if (size <= MAX_FORWARD_RAW_BYTES) {
		// The stored blob as `storage.get` holds it, alive for the whole read.
		held = new Uint8Array(readFileSync(path));
		const blob = await openAsBlob(path);
		raw = await readSealedBlobBytesStreaming(
			{ get: async () => blob },
			'kg_probe' as Id<'_storage'>,
			sealing === 'sealed' ? PROBE_SECRET : undefined
		);
	}
	let parts = 0;
	let decoded = 0;
	let refused = 0;
	let truncated = false;
	if (raw) {
		const located = locateForwardedParts(raw);
		truncated = located.truncated;
		for (const part of located.parts) {
			parts++;
			if (part.size > MAX_ATTACHMENT_BYTES) {
				refused++;
				continue;
			}
			const blob = new Blob([part.decode()]);
			decoded += blob.size;
		}
	}
	process.stdout.write(
		JSON.stringify({
			inputMiB: size / MiB,
			read: raw !== null,
			heldMiB: (held?.length ?? 0) / MiB,
			baselineMiB: baseline / MiB,
			peakMiB: (process.resourceUsage().maxRSS * 1024) / MiB,
			parts,
			decodedMiB: decoded / MiB,
			refused,
			truncated,
			seconds: process.uptime(),
		})
	);
} else {
	throw new Error(`unknown mode ${mode}`);
}
