import { describe, expect, it } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { extractAttachments, locateForwardedParts } from '../mailMime';

/** The forward's parts of a binary-string message, each decoded. */
function forwardedParts(text: string) {
	const { parts, truncated } = locateForwardedParts(
		Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff)
	);
	return {
		truncated,
		parts: parts.map(({ partIndex, filename, decode }) => ({
			partIndex,
			part: { filename, bytes: decode() },
		})),
	};
}

function leaf(type: string, headers: string[], body: string): string {
	return [`Content-Type: ${type}`, ...headers, '', body].join('\r\n');
}
function raw(leaves: string[]): string {
	return [
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="b"',
		'',
		'--b',
		leaf(
			'text/html',
			[],
			'<a href="cid:inv@x">invoice</a><img src="cid:photo@x"><img src="cid:logo@x">'
		),
		...leaves.flatMap((part) => ['--b', part]),
		'--b--',
		'',
	].join('\r\n');
}

describe('locateForwardedParts (#1257): what a forward carries, picked from the raw message', () => {
	it('carries attachment-marked parts whatever Content-IDs the body uses, not inline ones', () => {
		const { parts, truncated } = forwardedParts(
			raw([
				leaf(
					'application/pdf',
					['Content-ID: <inv@x>', 'Content-Disposition: attachment; filename="invoice.pdf"'],
					'pdf'
				),
				leaf(
					'image/png',
					['Content-ID: <photo@x>', 'Content-Disposition: attachment; filename="photo.png"'],
					'png'
				),
				leaf(
					'image/png',
					['Content-ID: <logo@x>', 'Content-Disposition: inline; filename="logo.png"'],
					'logo'
				),
				// A filename and no disposition is a file, as it always was.
				leaf('text/plain; name="notes.txt"', [], 'notes'),
			])
		);
		expect(truncated).toBe(false);
		expect(parts.map((p) => [p.partIndex, p.part.filename])).toEqual([
			['0', 'invoice.pdf'],
			['1', 'photo.png'],
			['3', 'notes.txt'],
		]);
	});

	it('names parts by their raw position, so equal filenames stay apart', () => {
		const { parts } = forwardedParts(
			raw([
				leaf(
					'application/pdf',
					['Content-Disposition: attachment; filename="invoice.pdf"'],
					'first'
				),
				leaf(
					'application/pdf',
					['Content-Disposition: attachment; filename="invoice.pdf"'],
					'second'
				),
			])
		);
		expect(parts.map((p) => [p.partIndex, new TextDecoder().decode(p.part.bytes)])).toEqual([
			['0', 'first'],
			['1', 'second'],
		]);
	});

	it('says when the walk was cut short by the part bound, so nothing past it is dropped unseen', () => {
		const inline = Array.from({ length: 1000 }, (_, i) =>
			leaf('image/png', [`Content-ID: <i${i}@x>`, 'Content-Disposition: inline'], 'x')
		);
		const pdf = leaf(
			'application/pdf',
			['Content-Disposition: attachment; filename="late.pdf"'],
			'pdf'
		);
		const read = forwardedParts(raw([...inline, pdf]));
		expect(read.truncated).toBe(true);
		expect(read.parts).toEqual([]);
	});

	it('says when the walk was cut short by the depth bound', () => {
		let body = leaf(
			'application/pdf',
			['Content-Disposition: attachment; filename="deep.pdf"'],
			'pdf'
		);
		for (let depth = 0; depth < 120; depth += 1) {
			body = [
				`Content-Type: multipart/mixed; boundary="d${depth}"`,
				'',
				`--d${depth}`,
				body,
				`--d${depth}--`,
				'',
			].join('\r\n');
		}
		const read = forwardedParts(['MIME-Version: 1.0', body].join('\r\n'));
		expect(read.truncated).toBe(true);
		expect(read.parts).toEqual([]);
	});

	it('picks what the string walker picks, across the repository corpus', () => {
		const root = join(import.meta.dirname, '../../../..');
		const files = globSync('**/*.eml', {
			cwd: root,
			exclude: (name) => name === 'node_modules' || name === '.git',
		});
		expect(files.length).toBeGreaterThan(50);
		for (const file of files) {
			const text = new TextDecoder('latin1').decode(readFileSync(join(root, file)));
			if ([...text].some((c) => c.charCodeAt(0) > 0xff)) continue; // windows-1252 C1 bytes
			const expected = extractAttachments(text).flatMap((part, index) =>
				part.disposition === 'attachment'
					? [{ partIndex: String(index), filename: part.filename, bytes: [...part.bytes] }]
					: []
			);
			const actual = forwardedParts(text).parts.map(({ partIndex, part }) => ({
				partIndex,
				filename: part.filename,
				bytes: [...part.bytes],
			}));
			expect(actual, file).toEqual(expected);
		}
	});
});
