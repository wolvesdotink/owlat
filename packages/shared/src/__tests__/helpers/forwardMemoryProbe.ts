/**
 * Run by `forwardMemory.test.ts` in its own Node process (`node --expose-gc
 * --import tsx`): write one raw message to a file, then take it through the
 * server's forward read as `fulfil` does, and print the process's peak
 * resident memory as JSON.
 *
 * The read is modelled with every copy `fulfil` makes: a message over
 * `MAX_FORWARD_RAW_BYTES` is not read; otherwise the stored blob's body as
 * `storage.get` holds it, the copy `blob.arrayBuffer()` returns, and the
 * unsealed copy are all alive at once (`readSealedBlobBytes`); then
 * `locateForwardedParts`, and each part within the per-file limit decoded and
 * handed to a `Blob` the way `storage.store` receives it, one at a time.
 * Nothing forces a collection in between.
 */
import { openAsBlob, rmSync, writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_ATTACHMENT_BYTES, MAX_FORWARD_RAW_BYTES } from '../../attachments';
import { locateForwardedParts } from '../../mailMime';

const MiB = 1024 * 1024;

/** Write a message whose one attachment body is `line` repeated, `size` bytes in all. */
function writeMessage(path: string, size: number, encoding: string, line: string): number {
	const head = [
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
		'',
	].join('\r\n');
	const tail = '\r\n--b--\r\n';
	const unit = `${line}\r\n`;
	const lines = Math.floor((size - head.length - tail.length) / unit.length);
	writeFileSync(path, head);
	const chunk = unit.repeat(4096);
	let written = 0;
	for (; written + 4096 <= lines; written += 4096) appendFileSync(path, chunk);
	appendFileSync(path, unit.repeat(lines - written) + tail);
	return head.length + lines * unit.length + tail.length;
}

const INPUTS: Record<string, [number, string, string]> = {
	'base64-64MiB': [64 * MiB, 'base64', 'QUJD'.repeat(19)],
	'base64-50MiB': [MAX_FORWARD_RAW_BYTES, 'base64', 'QUJD'.repeat(19)],
	// Just under the per-file limit once decoded, so it is decoded and stored.
	'base64-33MiB': [33 * MiB, 'base64', 'QUJD'.repeat(19)],
	// 75-character lines of `=41`: decodes to about a third of its size.
	'qp-8MiB': [8 * MiB, 'quoted-printable', '=41'.repeat(25)],
};

const name = process.argv[2] ?? '';
const input = INPUTS[name];
if (!input) throw new Error(`unknown input ${name}`);
const dir = mkdtempSync(join(tmpdir(), 'owlat-forward-memory-'));
const path = join(dir, 'message.eml');
const size = writeMessage(path, ...input);

(globalThis as { gc?: () => void }).gc?.();
const baseline = process.memoryUsage().rss;

async function read(): Promise<Uint8Array | null> {
	if (size > MAX_FORWARD_RAW_BYTES) return null;
	const stored = await (await openAsBlob(path)).arrayBuffer();
	const sealed = new Uint8Array(stored.slice(0));
	return sealed.slice();
}

const raw = await read();
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
rmSync(dir, { recursive: true, force: true });
process.stdout.write(
	JSON.stringify({
		name,
		inputMiB: size / MiB,
		read: raw !== null,
		baselineMiB: baseline / MiB,
		peakMiB: (process.resourceUsage().maxRSS * 1024) / MiB,
		parts,
		decodedMiB: decoded / MiB,
		refused,
		truncated,
	})
);
