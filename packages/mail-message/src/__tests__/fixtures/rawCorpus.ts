/**
 * The raw-message corpus for the parse-side differential (piece P3).
 *
 * Each fixture is a self-describing raw RFC 822 message that exercises one or
 * more of the consumed fields the six inbound consumers read: the address
 * headers (single, list, repeated, quoted-name, group), the threading headers
 * (`Message-ID`, `In-Reply-To`, single/multiple `References`), `Date:` in
 * several zones, RFC 2047 subjects, the `text` / `html | false` bodies, and the
 * document-order attachment set (named + inline).
 *
 * The corpus mirrors the shapes of the real MTA / mail-sync inline fixtures
 * (the ingest `RAW`, the bounce/forwarder message shapes) but keeps every part
 * a body or a NAMED attachment: message-part attachments (message/delivery-
 * status, message/rfc822) are the P2-pinned mailMime-parity classification, a
 * deliberate difference from mailparser handled at cutover, and out of the
 * facade differential's scope.
 */

const eml = (...lines: string[]): string => lines.join('\r\n');

export interface RawFixture {
	name: string;
	raw: string;
}

const PNG_1x1_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export const RAW_FIXTURES: RawFixture[] = [
	{
		name: 'simple-text-plain',
		raw: eml(
			'From: Alice <alice@example.com>',
			'To: Bob <bob@example.com>, carol@example.com',
			'Cc: dave@example.com',
			'Subject: Hello there',
			'Message-ID: <msg-123@example.com>',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'This is the body text.',
			''
		),
	},
	{
		name: 'no-message-id',
		raw: eml(
			'From: nobody@example.com',
			'To: someone@example.com',
			'Subject: No id here',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: text/plain',
			'',
			'body'
		),
	},
	{
		name: 'missing-date',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: No date',
			'Content-Type: text/plain',
			'',
			'no date header'
		),
	},
	{
		name: 'date-negative-offset',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: Zone',
			'Date: Fri, 11 Jul 2026 09:30:00 -0500',
			'',
			'zoned body'
		),
	},
	{
		name: 'date-gmt-named-zone',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: GMT',
			'Date: 11 Jul 2026 09:30:00 GMT',
			'',
			'gmt body'
		),
	},
	{
		name: 'encoded-word-subject-q',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'encoded subject'
		),
	},
	{
		name: 'encoded-word-subject-b',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: =?UTF-8?B?SGVsbG8gV29ybGQ=?=',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'b-encoded subject'
		),
	},
	{
		// A body-less html part would trigger mailparser's html->text fallback (it
		// synthesizes `.text` from html when no text/plain part exists) — a
		// mailparser convenience the reviewed parse tree (P2 `assembleBody`)
		// intentionally omits. Every html-bearing fixture therefore also carries a
		// text/plain sibling so `text` stays a true equality comparison.
		name: 'folded-header-recipients',
		raw: eml(
			'From: a@example.com',
			'To: One <one@example.com>,',
			'  Two <two@example.com>,',
			'  three@example.com',
			'Subject: Folded To header',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: text/plain',
			'',
			'folded recipients'
		),
	},
	{
		name: 'multipart-alternative',
		raw: eml(
			'From: Sender <sender@example.com>',
			'To: rcpt@example.com',
			'Subject: Both parts',
			'Message-ID: <alt-1@example.com>',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: multipart/alternative; boundary="ALT"',
			'',
			'--ALT',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Hello world',
			'--ALT',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>Hello <em>world</em></p>',
			'--ALT--'
		),
	},
	{
		name: 'quoted-display-name',
		raw: eml(
			'From: "Sender, Inc." <sender@example.com>',
			'To: "Doe, John" <john@example.com>',
			'Subject: Quoted names',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'quoted'
		),
	},
	{
		name: 'non-ascii-display-name',
		raw: eml(
			'From: =?UTF-8?Q?M=C3=BCller?= <mueller@example.com>',
			'To: =?UTF-8?B?UmVuw6llIER1cG9udA==?= <renee@example.com>',
			'Subject: Names',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'names'
		),
	},
	{
		name: 'multiple-recipients-one-header',
		raw: eml(
			'From: a@example.com',
			'To: One <one@example.com>, two@example.com, Three <three@example.com>',
			'Subject: Many to',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'multi'
		),
	},
	{
		name: 'repeated-to-headers',
		raw: eml(
			'From: a@example.com',
			'To: first@example.com',
			'To: second@example.com',
			'Subject: Repeated To',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'repeated'
		),
	},
	{
		name: 'address-group',
		raw: eml(
			'From: a@example.com',
			'To: Team:alice@example.com,bob@example.com;',
			'Subject: Group',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'group'
		),
	},
	{
		name: 'reply-to',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Reply-To: Support <support@example.com>',
			'Subject: With reply-to',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'reply'
		),
	},
	{
		name: 'in-reply-to-single-reference',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: Re: thread',
			'In-Reply-To: <parent@example.com>',
			'References: <parent@example.com>',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'reply body'
		),
	},
	{
		name: 'multiple-references',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: Re: deep thread',
			'In-Reply-To: <c@example.com>',
			'References: <a@example.com> <b@example.com> <c@example.com>',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'deep reply'
		),
	},
	{
		name: 'bcc-header',
		raw: eml(
			'From: a@example.com',
			'To: visible@example.com',
			'Bcc: blind@example.com',
			'Subject: Bcc present',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'',
			'bcc'
		),
	},
	{
		name: 'single-text-attachment',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: One attachment',
			'Message-ID: <att-1@example.com>',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: multipart/mixed; boundary="MIX"',
			'',
			'--MIX',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'see attached',
			'--MIX',
			'Content-Type: text/plain; name="note.txt"',
			'Content-Disposition: attachment; filename="note.txt"',
			'',
			'attachment payload',
			'--MIX--'
		),
	},
	{
		name: 'base64-binary-attachment',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: Binary attachment',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: multipart/mixed; boundary="BIN"',
			'',
			'--BIN',
			'Content-Type: text/plain',
			'',
			'image attached',
			'--BIN',
			'Content-Type: image/png; name="pixel.png"',
			'Content-Disposition: attachment; filename="pixel.png"',
			'Content-Transfer-Encoding: base64',
			'',
			PNG_1x1_B64,
			'--BIN--'
		),
	},
	{
		name: 'inline-image-plus-file',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: Inline and file',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: multipart/mixed; boundary="OUT"',
			'',
			// A text/plain body (not html): an html-without-text part would trigger
			// mailparser's html->text fallback. The inline image is still emitted +
			// classified as an inline attachment below.
			'--OUT',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'logo and a file',
			'--OUT',
			'Content-Type: image/png; name="logo.png"',
			'Content-Disposition: inline; filename="logo.png"',
			'Content-ID: <logo1>',
			'Content-Transfer-Encoding: base64',
			'',
			PNG_1x1_B64,
			'--OUT',
			'Content-Type: text/plain; name="report.txt"',
			'Content-Disposition: attachment; filename="report.txt"',
			'',
			'the report',
			'--OUT--'
		),
	},
	{
		name: 'quoted-printable-body',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: QP body',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: quoted-printable',
			'',
			'Caf=C3=A9 =E2=98=95 and more'
		),
	},
	{
		name: 'two-named-attachments',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: Two files',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: multipart/mixed; boundary="TWO"',
			'',
			'--TWO',
			'Content-Type: text/plain',
			'',
			'two files',
			'--TWO',
			'Content-Type: text/plain; name="a.txt"',
			'Content-Disposition: attachment; filename="a.txt"',
			'',
			'file a',
			'--TWO',
			'Content-Type: application/pdf; name="b.pdf"',
			'Content-Disposition: attachment; filename="b.pdf"',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from('%PDF-1.4 fake').toString('base64'),
			'--TWO--'
		),
	},
	{
		name: 'headers-only-no-body',
		raw: eml(
			'From: a@example.com',
			'To: b@example.com',
			'Subject: Headers only',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: text/plain',
			'',
			''
		),
	},
	{
		name: 'multipart-mixed-with-html-and-text',
		raw: eml(
			'From: Owlat <team@example.com>',
			'To: rcpt@example.com',
			'Cc: Carol <carol@example.com>',
			'Subject: =?UTF-8?Q?Digest?=',
			'Message-ID: <digest-9@example.com>',
			'In-Reply-To: <prev@example.com>',
			'References: <root@example.com> <prev@example.com>',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: multipart/mixed; boundary="KS"',
			'',
			'--KS',
			'Content-Type: multipart/alternative; boundary="KSA"',
			'',
			'--KSA',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Hi there',
			'--KSA',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>Hi there</p>',
			'--KSA--',
			'--KS',
			'Content-Type: application/pdf; name="resume.pdf"',
			'Content-Disposition: attachment; filename="resume.pdf"',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from('%PDF-1.4 resume').toString('base64'),
			'--KS--'
		),
	},
];
