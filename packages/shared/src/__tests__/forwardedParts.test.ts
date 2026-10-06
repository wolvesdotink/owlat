import { describe, expect, it } from 'vitest';
import { forwardedParts } from '../mailMime';

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

describe('forwardedParts (#1257): what a forward carries, picked from the raw message', () => {
	it('carries attachment-marked parts whatever Content-IDs the body uses, not inline ones', () => {
		const parts = forwardedParts(
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
		expect(parts.map((p) => [p.partIndex, p.part.filename])).toEqual([
			['0', 'invoice.pdf'],
			['1', 'photo.png'],
			['3', 'notes.txt'],
		]);
	});

	it('names parts by their raw position, so equal filenames stay apart', () => {
		const parts = forwardedParts(
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
});
