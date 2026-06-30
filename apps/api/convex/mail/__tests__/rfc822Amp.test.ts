/**
 * buildRfc822 AMP-part coverage.
 *
 * Regression guard for the gap where AMP for Email could be generated, previewed
 * and downloaded but never actually sent: the postbox .eml builder emitted only
 * text/plain + text/html, with no text/x-amp-html alternative. When a draft
 * carries a rendered AMP body it must ship as a `text/x-amp-html` part inside the
 * multipart/alternative, ordered before the HTML fallback so non-AMP clients
 * still render the HTML.
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
		subject: 'Weekly update',
		bodyHtml: '<p>Hello</p>',
		bodyText: 'Hello',
		state: 'pending_send',
		attachments: [],
		...overrides,
	};
}

const AMP_DOC = '<!doctype html><html ⚡4email><head></head><body>amp</body></html>';

describe('buildRfc822 AMP part', () => {
	it('omits text/x-amp-html when the draft has no AMP body', () => {
		const { raw } = buildRfc822(makeDraft(), [], '<id@owlat.test>', undefined, undefined);
		const eml = raw.toString('utf-8');
		expect(eml).not.toContain('text/x-amp-html');
		expect(eml).toContain('text/plain');
		expect(eml).toContain('text/html');
	});

	it('emits a text/x-amp-html alternative when the draft carries an AMP body', () => {
		const { raw } = buildRfc822(
			makeDraft({ bodyAmp: AMP_DOC }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');

		expect(eml).toContain('Content-Type: multipart/alternative');
		expect(eml).toContain('Content-Type: text/x-amp-html; charset=utf-8');
		// The AMP doc carries a non-ASCII lightning-bolt sigil, so it ships
		// quoted-printable (not 8bit) — the literal `⚡` must not appear raw and
		// its QP escape must be present.
		expect(eml).not.toContain('⚡');
		expect(eml).toContain('=E2=9A=A1');
		expect(eml).toContain('Content-Transfer-Encoding: quoted-printable');

		// Ordering: text/plain → text/x-amp-html → text/html, so non-AMP clients
		// (which pick the LAST renderable part) fall through to the HTML fallback.
		const plainIdx = eml.indexOf('text/plain');
		const ampIdx = eml.indexOf('text/x-amp-html');
		const htmlIdx = eml.indexOf('text/html');
		expect(plainIdx).toBeGreaterThanOrEqual(0);
		expect(ampIdx).toBeGreaterThan(plainIdx);
		expect(htmlIdx).toBeGreaterThan(ampIdx);
	});

	it('nests the AMP part inside the alternative when attachments are present', () => {
		const att = {
			filename: 'a.txt',
			contentType: 'text/plain',
			isInline: false,
			data: Buffer.from('file body'),
		};
		const { raw } = buildRfc822(
			makeDraft({ bodyAmp: AMP_DOC }),
			[att],
			'<id@owlat.test>',
			undefined,
			undefined,
		);
		const eml = raw.toString('utf-8');

		expect(eml).toContain('Content-Type: multipart/mixed');
		expect(eml).toContain('Content-Type: multipart/alternative');
		expect(eml).toContain('Content-Type: text/x-amp-html; charset=utf-8');
		// The AMP alternative must precede the attachment part.
		expect(eml.indexOf('text/x-amp-html')).toBeLessThan(eml.indexOf('Content-Disposition: attachment'));
	});
});
