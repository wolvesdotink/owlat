/**
 * The byte-level locator (`parse/locate.ts`) against the string walker
 * (`parse/body.ts`): over every `.eml` in the repository and a set of built
 * messages (nesting, the part and depth bounds, odd delimiters, every transfer
 * encoding and its malformed forms), both must produce the same leaves in the
 * same order (so the same `partIndex`es), the same attachment verdicts, names
 * and dispositions, the same `truncated`, and the same decoded bytes.
 */
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	isAttachmentPart,
	parseMimeTreeWithBounds,
	partDisposition,
	partFilename,
	transferDecode,
	walkLeaves,
	MAX_MIME_PARTS,
	type MimeNode,
} from '../parse/body';
import {
	decodeLocated,
	decodedLength,
	locateMimeTree,
	MAX_HEADER_BYTES,
	MAX_PART_HEADER_BYTES,
} from '../parse/locate';
import { bytesToBinaryString } from '../parse/binaryString';

const ROOT = join(import.meta.dirname, '../../../..');

interface LeafView {
	type: string;
	attachment: boolean;
	disposition: string;
	filename: string;
	encoding: string | undefined;
	bytes: number[] | number;
}

function stringView(raw: Uint8Array): { leaves: LeafView[]; truncated: boolean } {
	const { root, truncated } = parseMimeTreeWithBounds(bytesToBinaryString(raw));
	const leaves: LeafView[] = [];
	walkLeaves(root, (leaf) => {
		const encoding = leaf.headers.last('content-transfer-encoding');
		const bytes = transferDecode(leaf.rawBody, encoding);
		leaves.push({ ...describeLeaf(leaf), encoding, bytes: [...bytes] });
	});
	return { leaves, truncated };
}

function byteView(raw: Uint8Array): { leaves: LeafView[]; truncated: boolean } {
	const { root, bodies, truncated } = locateMimeTree(raw);
	const leaves: LeafView[] = [];
	walkLeaves(root, (leaf) => {
		const encoding = leaf.headers.last('content-transfer-encoding');
		const body = bodies.get(leaf)!;
		const length = decodedLength(raw, body, encoding);
		const bytes = decodeLocated(raw, body, encoding, length);
		expect(bytes.length).toBe(length);
		leaves.push({ ...describeLeaf(leaf), encoding, bytes: [...bytes] });
	});
	return { leaves, truncated };
}

function describeLeaf(leaf: MimeNode) {
	return {
		type: leaf.contentType.value,
		attachment: isAttachmentPart(leaf),
		disposition: partDisposition(leaf),
		filename: partFilename(leaf),
	};
}

function expectSame(raw: Uint8Array) {
	expect(byteView(raw)).toEqual(stringView(raw));
}

const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
const crlf = (...lines: string[]) => lines.join('\r\n');

function flat(count: number, part = (i: number) => ['Content-Type: text/plain', '', `p${i}`]) {
	const lines = ['Content-Type: multipart/mixed; boundary="F"', ''];
	for (let i = 0; i < count; i++) lines.push('--F', ...part(i));
	lines.push('--F--', '');
	return crlf(...lines);
}

function nested(levels: number, leaf: string[]) {
	const open: string[] = [];
	const close: string[] = [];
	for (let i = 0; i < levels; i++) {
		open.push(`Content-Type: multipart/mixed; boundary="n${i}"`, '', `--n${i}`);
		close.unshift(`--n${i}--`);
	}
	return crlf(...open, ...leaf, ...close);
}

const pdf = (name: string, body: string, encoding = 'base64') => [
	`Content-Type: application/pdf; name="${name}"`,
	`Content-Disposition: attachment; filename="${name}"`,
	`Content-Transfer-Encoding: ${encoding}`,
	'',
	body,
];

const BUILT: Record<string, string> = {
	'mixed, related, alternative, inline and attached': crlf(
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="m"',
		'',
		'preamble',
		'--m',
		'Content-Type: multipart/alternative; boundary="a"',
		'',
		'--a',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		'Gr=C3=BC=C3=9Fe, a soft=',
		' break and =3D signs =3d',
		'--a',
		'Content-Type: multipart/related; boundary="r"',
		'',
		'--r',
		'Content-Type: text/html',
		'',
		'<a href="cid:inv@x">inv</a><img src="cid:logo@x">',
		'--r',
		'Content-Type: image/png',
		'Content-ID: <logo@x>',
		'Content-Disposition: inline; filename="logo.png"',
		'Content-Transfer-Encoding: base64',
		'',
		'iVBORw0KGgo=',
		'--r--',
		'--a--',
		'--m',
		...pdf('invoice.pdf', 'JVBERi0xLjQK'),
		'--m',
		...pdf('invoice.pdf', 'c2Vjb25k'),
		'--m',
		'Content-Type: text/plain; name="notes.txt"',
		'',
		'no disposition,',
		'only a name',
		'--m',
		'Content-Type: message/rfc822',
		'Content-Disposition: attachment; filename="fwd.eml"',
		'',
		'Subject: inner',
		'Content-Type: multipart/mixed; boundary="inner"',
		'',
		'--inner',
		...pdf('inner.pdf', 'aW5uZXI='),
		'--inner--',
		'--m--  ',
		'epilogue'
	),
	'base64 forms atob refuses or trims': flat(8, (i) =>
		pdf(
			`b${i}.bin`,
			['QUJD', 'QUI=', 'QQ==', 'QUJDRA', 'QUJDR', 'Q=UJD', 'QUJD===', ' Q U J D \t'][i]!
		)
	),
	'quoted-printable edge cases': flat(6, (i) =>
		pdf(
			`q${i}.txt`,
			[
				'=41=42=4',
				'=\r\n=41',
				'==\r\n41',
				'=4=\r\n1 tail=',
				'lower =e9 upper =E9 bad =G1',
				'line one\r\nline two\r\n',
			][i]!,
			'quoted-printable'
		)
	),
	'7bit, 8bit and unknown encodings': flat(3, (i) =>
		pdf(`e${i}.txt`, 'a\r\nb\r\n\r\nc', ['7bit', 'binary', 'x-uuencode'][i]!)
	),
	'LF-only line endings and a headers-only part': [
		'Content-Type: multipart/mixed; boundary="L"',
		'',
		'--L',
		'Content-Disposition: attachment; filename="lf.txt"',
		'',
		'one',
		'two',
		'--L',
		'Content-Disposition: attachment; filename="empty.txt"',
		'--L--',
		'',
	].join('\n'),
	'a single-part message that is an attachment': crlf(
		'Content-Type: application/pdf; name="solo.pdf"',
		'Content-Disposition: attachment',
		'Content-Transfer-Encoding: 7bit',
		'',
		'top\r\nlevel\r\nkept verbatim'
	),
	'no boundary, and a slashless multipart': crlf(
		'Content-Type: multipart/mixed',
		'',
		'--x',
		'Content-Disposition: attachment; filename="a.txt"',
		'',
		'body'
	),
	'the part bound, with a file past it': flat(MAX_MIME_PARTS + 1, (i) =>
		i < MAX_MIME_PARTS
			? ['Content-Type: image/png', 'Content-Disposition: inline', '', 'x']
			: pdf('late.pdf', 'bGF0ZQ==')
	),
	'exactly the part bound': flat(MAX_MIME_PARTS, (i) => pdf(`f${i}.pdf`, 'eA==')),
	'the depth bound, with a file past it': nested(120, pdf('deep.pdf', 'ZGVlcA==')),
	'exactly the depth bound': nested(100, pdf('deep.pdf', 'ZGVlcA==')),
	'header blocks within the budgets': flat(4, (i) => [
		`X-Big: ${'h'.repeat(200 * 1024)}`,
		...pdf(`h${i}.pdf`, 'aA=='),
	]),
	// Bytes 0x80-0x9F, which a windows-1252 decode (`TextDecoder('latin1')`)
	// changes: both paths must keep them exactly, in bodies and in headers.
	'8-bit bytes in 0x80-0x9F': flat(1, () => pdf('c1.bin', '\u0080\u0099 ÿ', '8bit')),
	'8-bit bytes in 0x80-0x9F in a header and a binary body': flat(2, (i) =>
		i === 0
			? pdf('\u0080\u009f.bin', '\u0000A\u0080\u0099\u009f ÿ', 'binary')
			: pdf('clean.pdf', 'Y2xlYW4=')
	),
};

describe('locateMimeTree: the same leaves, verdicts and bytes as the string walker', () => {
	const files = globSync('**/*.eml', {
		cwd: ROOT,
		exclude: (name) => name === 'node_modules' || name === '.git',
	});

	it('finds the repository corpus', () => {
		expect(files.length).toBeGreaterThan(50);
	});

	it.each(files)('%s', (file) => {
		expectSame(new Uint8Array(readFileSync(join(ROOT, file))));
	});

	it.each(Object.entries(BUILT))('%s', (_name, message) => {
		expectSame(bytes(message));
	});

	it('reports the bounds the way the walker does', () => {
		expect(locateMimeTree(bytes(BUILT['the part bound, with a file past it']!)).truncated).toBe(
			true
		);
		expect(locateMimeTree(bytes(BUILT['the depth bound, with a file past it']!)).truncated).toBe(
			true
		);
		expect(locateMimeTree(bytes(BUILT['exactly the part bound']!)).truncated).toBe(false);
	});

	it('copies 8-bit bytes exactly', () => {
		const raw = bytes(BUILT['8-bit bytes in 0x80-0x9F']!);
		const { root, bodies } = locateMimeTree(raw);
		const leaf = root.children[0]!;
		const body = bodies.get(leaf)!;
		const out = decodeLocated(raw, body, '8bit', decodedLength(raw, body, '8bit'));
		expect([...out]).toEqual([0x80, 0x99, 0xa0, 0xff]);
	});

	it('hands the string walker the same 8-bit header and body bytes', () => {
		const raw = bytes(BUILT['8-bit bytes in 0x80-0x9F in a header and a binary body']!);
		const { leaves } = stringView(raw);
		const { root } = parseMimeTreeWithBounds(bytesToBinaryString(raw));
		expect(root.children[0]?.headers.last('content-disposition')).toContain('\u0080\u009f.bin');
		// The two bytes are not UTF-8, so the filename reads them as windows-1252.
		expect(leaves[0]?.filename).toBe('€Ÿ.bin');
		expect(leaves[0]?.bytes).toEqual([0x00, 0x41, 0x80, 0x99, 0x9f, 0xa0, 0xff]);
	});

	it('stops earlier than the string walker on header floods, as truncated', () => {
		const floods = {
			'one part over the per-part budget': flat(1, () => [
				`X-Big: ${'h'.repeat(MAX_PART_HEADER_BYTES)}`,
				...pdf('a.pdf', 'aA=='),
			]),
			'a message over the total budget': flat(6, (i) => [
				`X-Big: ${'h'.repeat(200 * 1024)}`,
				...pdf(`h${i}.pdf`, 'aA=='),
			]),
			'headers with no blank line to end them': 'X: a\r\n'.repeat(
				Math.ceil((MAX_HEADER_BYTES + 1) / 6)
			),
		};
		for (const [name, message] of Object.entries(floods)) {
			const raw = bytes(message);
			expect(stringView(raw).truncated, name).toBe(false);
			expect(locateMimeTree(raw).truncated, name).toBe(true);
		}
	});
});

describe('locateMimeTree: node segments', () => {
	const enc = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
	const slice = (raw: Uint8Array, seg: { start: number; end: number } | undefined) =>
		seg ? Buffer.from(raw.subarray(seg.start, seg.end)).toString('latin1') : undefined;

	it('spans each part from after its delimiter line to before the next one', () => {
		const first =
			'Content-Type: multipart/alternative; boundary="in"\r\n\r\n--in\r\n\r\nx\r\n--in--';
		const raw = enc(
			[
				'Content-Type: multipart/signed; boundary="b"',
				'',
				'preamble',
				'--b',
				first,
				'--b  ',
				'Content-Type: application/pgp-signature',
				'',
				'sig',
				'--b--',
				'epilogue',
			].join('\r\n')
		);
		const { root, segments } = locateMimeTree(raw);
		expect(root.children).toHaveLength(2);
		expect(slice(raw, segments.get(root))).toBe(Buffer.from(raw).toString('latin1'));
		expect(slice(raw, segments.get(root.children[0]!))).toBe(first);
		expect(slice(raw, segments.get(root.children[1]!))).toBe(
			'Content-Type: application/pgp-signature\r\n\r\nsig'
		);
	});
});
