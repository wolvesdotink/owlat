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
import { decodeLocated, decodedLength, locateMimeTree } from '../parse/locate';

const ROOT = join(import.meta.dirname, '../../../..');
const latin1 = new TextDecoder('latin1');

interface LeafView {
	type: string;
	attachment: boolean;
	disposition: string;
	filename: string;
	encoding: string | undefined;
	bytes: number[] | number;
}

/** True when the string path's windows-1252 view changes these bytes. */
function hasC1(bytes: Uint8Array): boolean {
	return bytes.some((b) => b >= 0x80 && b <= 0x9f);
}

function stringView(raw: Uint8Array): { leaves: LeafView[]; truncated: boolean } {
	const { root, truncated } = parseMimeTreeWithBounds(latin1.decode(raw));
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
	const byString = stringView(raw);
	const byBytes = byteView(raw);
	if (hasC1(raw)) {
		// 8-bit bytes in 0x80-0x9F: the string path maps them through
		// windows-1252; compare everything but those bodies' bytes.
		const lengths = (view: typeof byString) =>
			view.leaves.map((leaf) => ({
				...leaf,
				bytes: Array.isArray(leaf.bytes) ? leaf.bytes.length : leaf.bytes,
			}));
		expect(lengths(byBytes)).toEqual(lengths(byString));
		expect(byBytes.truncated).toBe(byString.truncated);
		return;
	}
	expect(byBytes).toEqual(byString);
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
	'8-bit bytes the string path maps through windows-1252': flat(1, () =>
		pdf('c1.bin', '\u0080\u0099 ÿ', '8bit')
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
		const raw = bytes(BUILT['8-bit bytes the string path maps through windows-1252']!);
		const { root, bodies } = locateMimeTree(raw);
		const leaf = root.children[0]!;
		const body = bodies.get(leaf)!;
		const out = decodeLocated(raw, body, '8bit', decodedLength(raw, body, '8bit'));
		expect([...out]).toEqual([0x80, 0x99, 0xa0, 0xff]);
	});
});
