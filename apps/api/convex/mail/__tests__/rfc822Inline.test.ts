/**
 * buildRfc822 inline-image (multipart/related) coverage.
 *
 * The Postbox Simple composer embeds pasted/dropped images in the body as
 * `cid:` references and uploads their bytes as INLINE draft attachments
 * (isInline + Content-ID). Those inline parts must ship in a multipart/related
 * alongside the HTML that references them — NOT as ordinary attachments — so
 * mail clients resolve the `cid:` src and render the image in place. File
 * attachments stay in the outer multipart/mixed.
 */

import { describe, it, expect } from 'vitest';
import { buildRfc822, type DraftRow } from '../rfc822';

function makeDraft(overrides: Partial<DraftRow> = {}): DraftRow {
	return {
		_id: 'draft1' as DraftRow['_id'],
		mailboxId: 'mailbox1' as DraftRow['mailboxId'],
		toAddresses: ['rcpt@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		fromAddress: 'sender@owlat.test',
		subject: 'With a picture',
		bodyHtml: '<p>See <img src="cid:pic-1"></p>',
		bodyText: 'See [image]',
		state: 'pending_send',
		attachments: [],
		...overrides,
	};
}

const PNG = Buffer.from('\x89PNG\r\n\x1a\n_fake_png_bytes_', 'latin1');

describe('buildRfc822 inline images (multipart/related, RFC 2387)', () => {
	it('emits a multipart/related with the inline part carrying a matching Content-ID', () => {
		const { raw } = buildRfc822(
			makeDraft(),
			[{ filename: 'pic.png', contentType: 'image/png', isInline: true, contentId: 'pic-1', data: PNG }],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');

		expect(eml).toContain('Content-Type: multipart/related; type="text/html"');
		expect(eml).toContain('Content-ID: <pic-1>');
		expect(eml).toContain('Content-Disposition: inline; filename="pic.png"');
		// The body still references the image by cid.
		expect(eml).toContain('cid:pic-1');
		// An embedded image is NOT a file attachment: no mixed wrapper, no
		// attachment disposition when it is the only part.
		expect(eml).not.toContain('multipart/mixed');
		expect(eml).not.toContain('Content-Disposition: attachment');
	});

	it('nests the related body inside multipart/mixed when a file attachment is also present', () => {
		const { raw } = buildRfc822(
			makeDraft(),
			[
				{ filename: 'pic.png', contentType: 'image/png', isInline: true, contentId: 'pic-1', data: PNG },
				{ filename: 'report.pdf', contentType: 'application/pdf', isInline: false, data: Buffer.from('%PDF-1.4') },
			],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');

		expect(eml).toContain('Content-Type: multipart/mixed');
		expect(eml).toContain('Content-Type: multipart/related');
		// The related (with the inline image) comes before the attached file part.
		expect(eml.indexOf('multipart/related')).toBeLessThan(eml.indexOf('Content-Disposition: attachment'));
		expect(eml).toContain('Content-Disposition: inline; filename="pic.png"');
		expect(eml).toContain('Content-Disposition: attachment; filename="report.pdf"');
		expect(eml).toContain('Content-ID: <pic-1>');
	});

	it('treats an inline part with no Content-ID as an ordinary attachment (no related wrapper)', () => {
		const { raw } = buildRfc822(
			makeDraft({ bodyHtml: '<p>hi</p>', bodyText: 'hi' }),
			[{ filename: 'x.png', contentType: 'image/png', isInline: true, data: PNG }],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');
		expect(eml).not.toContain('multipart/related');
		expect(eml).toContain('Content-Type: multipart/mixed');
	});
});
