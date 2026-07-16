/**
 * The differential corpus for `composeMessage` — the reviewable heart of piece
 * M2. Each case is a structured, plain-data description of a message (no wire
 * bytes) that is fed to BOTH our `composeMessage` and nodemailer's
 * `MailComposer` through the two adapters at the bottom of this file. The
 * differential suite (`compose.differential.test.ts`) composes each case with
 * both, parses both with mailparser, and asserts semantic equality.
 *
 * Every case pins an explicit `messageId` and `date` so the two composers agree
 * on those header values (and so the determinism gate can re-run a case with the
 * same seed and get byte-identical output). Structural decisions (single part vs
 * multipart/alternative) are driven by whether `text`/`html`/`amp` are present,
 * and BOTH composers see identical `text`/`html`/`amp`, so any part-tree
 * divergence is a real bug — not a fixture artefact.
 *
 * Inputs are kept free of control characters and non-ASCII attachment filenames:
 * header/localpart injection stripping and RFC 2231 filename encoding are out of
 * this differential's scope (covered by unit tests / deferred pieces), and mixing
 * them in would compare composer cosmetics rather than semantic parity.
 */

import type { ComposeMessageInput } from '../../src/index';
import type Mail from 'nodemailer/lib/mailer';

export interface CorpusAttachment {
	filename: string;
	contentType: string;
	content: Buffer;
	/** Present ⇒ an inline part referenced by a `cid:` URL in the HTML. */
	cid?: string;
}

export interface CorpusCase {
	name: string;
	from: string;
	replyTo?: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	html?: string;
	text?: string;
	amp?: string;
	attachments?: CorpusAttachment[];
	headers?: Record<string, string>;
	messageId: string;
	date: Date;
	inReplyTo?: string;
	references?: string;
}

const FIXED_DATE = new Date('2026-07-11T09:30:00.000Z');
const mid = (n: number): string => `<corpus-${n.toString()}@owlat.test>`;

const PNG_1x1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);

const LONG_LINE = 'x'.repeat(1200);
const LONG_UNICODE_SUBJECT = 'ü'.repeat(120);
const LONG_ASCII_SUBJECT = 'Status update '.repeat(90).trim();

function manyRecipients(n: number, domain: string): string[] {
	return Array.from(
		{ length: n },
		(_, i) => `Recipient Number ${(i + 1).toString()} <user${(i + 1).toString()}@${domain}>`
	);
}

export const CORPUS: CorpusCase[] = [
	{
		name: 'text-only',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Plain text only',
		text: 'Just a plain text body.\nSecond line.',
		messageId: mid(1),
		date: FIXED_DATE,
	},
	{
		name: 'html-only',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'HTML only',
		html: '<p>Hello <strong>world</strong></p>',
		messageId: mid(2),
		date: FIXED_DATE,
	},
	{
		name: 'html-and-text',
		from: 'Sender Name <sender@owlat.test>',
		to: ['Recipient <rcpt@example.com>'],
		subject: 'Both parts',
		html: '<p>Hello <em>world</em></p>',
		text: 'Hello world',
		messageId: mid(3),
		date: FIXED_DATE,
	},
	{
		name: 'unicode-subject-short',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Grüße aus München ☕',
		html: '<p>hi</p>',
		text: 'hi',
		messageId: mid(4),
		date: FIXED_DATE,
	},
	{
		name: 'unicode-subject-fold-boundary',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: LONG_UNICODE_SUBJECT,
		html: '<p>long subject</p>',
		text: 'long subject',
		messageId: mid(5),
		date: FIXED_DATE,
	},
	{
		name: 'long-ascii-subject',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: LONG_ASCII_SUBJECT,
		html: '<p>x</p>',
		text: 'x',
		messageId: mid(6),
		date: FIXED_DATE,
	},
	{
		name: 'empty-subject',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: '',
		html: '<p>no subject</p>',
		text: 'no subject',
		messageId: mid(7),
		date: FIXED_DATE,
	},
	{
		name: 'non-ascii-from-display-name',
		from: 'Müller Groß <mueller@owlat.test>',
		to: ['rcpt@example.com'],
		subject: 'From name',
		html: '<p>x</p>',
		text: 'x',
		messageId: mid(8),
		date: FIXED_DATE,
	},
	{
		name: 'non-ascii-to-display-name',
		from: 'sender@owlat.test',
		to: ['Renée Dupont <renee@example.com>'],
		subject: 'To name',
		html: '<p>x</p>',
		text: 'x',
		messageId: mid(9),
		date: FIXED_DATE,
	},
	{
		name: 'long-recipient-list',
		from: 'sender@owlat.test',
		to: manyRecipients(25, 'example.com'),
		subject: 'Big to list',
		html: '<p>bulk</p>',
		text: 'bulk',
		messageId: mid(10),
		date: FIXED_DATE,
	},
	{
		name: 'to-cc-bcc-mix',
		from: 'sender@owlat.test',
		to: ['a@example.com', 'b@example.com'],
		cc: ['Carol <c@example.com>', 'd@example.com'],
		bcc: ['secret@hidden.test'],
		subject: 'Mixed recipients',
		html: '<p>x</p>',
		text: 'x',
		messageId: mid(11),
		date: FIXED_DATE,
	},
	{
		name: 'reply-to',
		from: 'sender@owlat.test',
		replyTo: 'Support <support@owlat.test>',
		to: ['rcpt@example.com'],
		subject: 'With reply-to',
		html: '<p>x</p>',
		text: 'x',
		messageId: mid(12),
		date: FIXED_DATE,
	},
	{
		name: 'in-reply-to-and-references',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Re: thread',
		html: '<p>reply</p>',
		text: 'reply',
		inReplyTo: '<parent@example.com>',
		references: '<root@example.com> <parent@example.com>',
		messageId: mid(13),
		date: FIXED_DATE,
	},
	{
		name: 'custom-headers-ascii',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Tracing headers',
		html: '<p>x</p>',
		text: 'x',
		headers: {
			'X-Owlat-Message-Id': 'msg_abc123',
			'X-Owlat-Org-Id': 'org_def456',
		},
		messageId: mid(14),
		date: FIXED_DATE,
	},
	{
		name: 'custom-header-unicode-value',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Unicode header value',
		html: '<p>x</p>',
		text: 'x',
		headers: { 'X-Owlat-Note': 'Grüße' },
		messageId: mid(15),
		date: FIXED_DATE,
	},
	{
		name: 'single-text-attachment',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'One attachment',
		html: '<p>see attached</p>',
		text: 'see attached',
		attachments: [
			{
				filename: 'note.txt',
				contentType: 'text/plain',
				content: Buffer.from('attachment payload'),
			},
		],
		messageId: mid(16),
		date: FIXED_DATE,
	},
	{
		name: 'binary-attachment',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Binary attachment',
		html: '<p>image attached</p>',
		text: 'image attached',
		attachments: [{ filename: 'pixel.png', contentType: 'image/png', content: PNG_1x1 }],
		messageId: mid(17),
		date: FIXED_DATE,
	},
	{
		name: 'multiple-attachments',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Two attachments',
		html: '<p>two files</p>',
		text: 'two files',
		attachments: [
			{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('file a') },
			{
				filename: 'b.bin',
				contentType: 'application/octet-stream',
				content: Buffer.from([0, 1, 2, 3, 255, 254]),
			},
		],
		messageId: mid(18),
		date: FIXED_DATE,
	},
	{
		name: 'inline-image',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Inline image',
		html: '<p>logo: <img src="cid:logo123"></p>',
		text: 'logo',
		attachments: [
			{ filename: 'logo.png', contentType: 'image/png', content: PNG_1x1, cid: 'logo123' },
		],
		messageId: mid(19),
		date: FIXED_DATE,
	},
	{
		name: 'inline-plus-file-attachment',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Inline and attachment',
		html: '<p>logo <img src="cid:logo123"> and a file</p>',
		text: 'logo and a file',
		attachments: [
			{ filename: 'logo.png', contentType: 'image/png', content: PNG_1x1, cid: 'logo123' },
			{ filename: 'report.txt', contentType: 'text/plain', content: Buffer.from('the report') },
		],
		messageId: mid(20),
		date: FIXED_DATE,
	},
	{
		name: 'amp-html-text',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'AMP email',
		html: '<p>HTML fallback</p>',
		text: 'plain fallback',
		amp: '<!doctype html><html amp4email><body>AMP body</body></html>',
		messageId: mid(21),
		date: FIXED_DATE,
	},
	{
		name: 'amp-with-attachments-and-inline',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'AMP with parts',
		html: '<p>fallback <img src="cid:hero1"></p>',
		text: 'fallback',
		amp: '<!doctype html><html amp4email><body>AMP</body></html>',
		attachments: [
			{ filename: 'hero.png', contentType: 'image/png', content: PNG_1x1, cid: 'hero1' },
			{
				filename: 'terms.txt',
				contentType: 'text/plain',
				content: Buffer.from('terms and conditions'),
			},
		],
		messageId: mid(22),
		date: FIXED_DATE,
	},
	{
		name: 'empty-text-with-html',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Empty text',
		html: '<p>only html survives</p>',
		text: '',
		messageId: mid(23),
		date: FIXED_DATE,
	},
	{
		name: 'long-line-in-text',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Long text line',
		html: '<p>x</p>',
		text: `intro\n${LONG_LINE}\noutro`,
		messageId: mid(24),
		date: FIXED_DATE,
	},
	{
		name: 'long-line-in-html',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Long html line',
		html: `<p>${LONG_LINE}</p>`,
		text: 'x',
		messageId: mid(25),
		date: FIXED_DATE,
	},
	{
		name: 'unicode-body-emoji',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Emoji body',
		html: '<p>Party 🎉🎈 with café ☕ and Grüße</p>',
		text: 'Party 🎉🎈 with café ☕ and Grüße',
		messageId: mid(26),
		date: FIXED_DATE,
	},
	{
		name: 'text-with-equals-and-specials',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'QP specials',
		html: '<p>a=b, c=d</p>',
		text: 'a=b and c=d and 100% done',
		messageId: mid(27),
		date: FIXED_DATE,
	},
	{
		name: 'multiparagraph-text',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Paragraphs',
		html: '<p>one</p><p>two</p><p>three</p>',
		text: 'one\n\ntwo\n\nthree',
		messageId: mid(28),
		date: FIXED_DATE,
	},
	{
		name: 'many-cc',
		from: 'sender@owlat.test',
		to: ['primary@example.com'],
		cc: manyRecipients(15, 'cc.example.com'),
		subject: 'Many cc',
		html: '<p>cc storm</p>',
		text: 'cc storm',
		messageId: mid(29),
		date: FIXED_DATE,
	},
	{
		name: 'unicode-attachment-content',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Unicode attachment bytes',
		html: '<p>attached</p>',
		text: 'attached',
		attachments: [
			{
				filename: 'unicode.txt',
				contentType: 'text/plain',
				content: Buffer.from('Grüße — café ☕ 🎉', 'utf-8'),
			},
		],
		messageId: mid(30),
		date: FIXED_DATE,
	},
	{
		name: 'quoted-display-name',
		from: '"Sender, Inc." <sender@owlat.test>',
		to: ['rcpt@example.com'],
		subject: 'Quoted name',
		html: '<p>x</p>',
		text: 'x',
		messageId: mid(31),
		date: FIXED_DATE,
	},
	{
		name: 'mixed-ascii-unicode-names',
		from: 'sender@owlat.test',
		to: ['Alice <alice@example.com>', 'Renée <renee@example.com>', 'bob@example.com'],
		subject: 'Mixed names',
		html: '<p>x</p>',
		text: 'x',
		messageId: mid(32),
		date: FIXED_DATE,
	},
	{
		name: 'html-with-cid-only',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'CID no text emphasis',
		html: '<div><img src="cid:pic9"><span>caption</span></div>',
		text: 'caption',
		attachments: [{ filename: 'pic.png', contentType: 'image/png', content: PNG_1x1, cid: 'pic9' }],
		messageId: mid(33),
		date: FIXED_DATE,
	},
	{
		name: 'large-text-body',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Large body',
		html: '<p>large</p>',
		text: Array.from(
			{ length: 200 },
			(_, i) => `Line number ${(i + 1).toString()} of the body.`
		).join('\n'),
		messageId: mid(34),
		date: FIXED_DATE,
	},
	{
		name: 'amp-minimal',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Minimal amp',
		html: '<p>h</p>',
		text: 't',
		amp: '<html amp4email><body>a</body></html>',
		messageId: mid(35),
		date: FIXED_DATE,
	},
	{
		name: 'bcc-only-recipient',
		from: 'sender@owlat.test',
		to: ['visible@example.com'],
		bcc: ['blind1@example.com', 'blind2@example.com'],
		subject: 'Bcc handling',
		html: '<p>x</p>',
		text: 'x',
		messageId: mid(36),
		date: FIXED_DATE,
	},
	{
		name: 'unicode-subject-and-body-and-name',
		from: 'Grüße Team <team@owlat.test>',
		to: ['Renée <renee@example.com>'],
		subject: 'Grüße — café résumé ☕',
		html: '<p>Grüße — café résumé</p>',
		text: 'Grüße — café résumé',
		messageId: mid(37),
		date: FIXED_DATE,
	},
	{
		name: 'attachment-with-explicit-content-type',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'PDF attachment',
		html: '<p>invoice</p>',
		text: 'invoice',
		attachments: [
			{
				filename: 'invoice.pdf',
				contentType: 'application/pdf',
				content: Buffer.from('%PDF-1.4 fake pdf bytes'),
			},
		],
		messageId: mid(38),
		date: FIXED_DATE,
	},
	{
		name: 'crlf-and-tabs-in-text',
		from: 'sender@owlat.test',
		to: ['rcpt@example.com'],
		subject: 'Whitespace',
		html: '<p>ws</p>',
		text: 'col1\tcol2\tcol3\nrow2a\trow2b\trow2c',
		messageId: mid(39),
		date: FIXED_DATE,
	},
	{
		name: 'kitchen-sink',
		from: 'Owlat Team <team@owlat.test>',
		replyTo: 'Reply Desk <reply@owlat.test>',
		to: ['Renée Dupont <renee@example.com>', 'bob@example.com'],
		cc: ['Carol <carol@example.com>'],
		bcc: ['audit@hidden.test'],
		subject: 'Grüße — your monthly digest ☕',
		html: '<p>Hi <img src="cid:brand7"> — see attached résumé</p>',
		text: 'Hi — see attached résumé',
		amp: '<!doctype html><html amp4email><body>Interactive digest</body></html>',
		attachments: [
			{ filename: 'brand.png', contentType: 'image/png', content: PNG_1x1, cid: 'brand7' },
			{
				filename: 'resume.pdf',
				contentType: 'application/pdf',
				content: Buffer.from('%PDF-1.4 resume'),
			},
		],
		headers: { 'X-Owlat-Message-Id': 'msg_kitchen', 'X-Owlat-Org-Id': 'org_sink' },
		inReplyTo: '<prev@example.com>',
		references: '<root@example.com> <prev@example.com>',
		messageId: mid(40),
		date: FIXED_DATE,
	},
];

/** Adapt a corpus case to our `composeMessage` input. */
export function toComposeInput(c: CorpusCase): ComposeMessageInput {
	return {
		from: c.from,
		replyTo: c.replyTo,
		to: c.to,
		cc: c.cc,
		bcc: c.bcc,
		subject: c.subject,
		html: c.html,
		text: c.text,
		amp: c.amp,
		attachments: c.attachments?.map((a) => ({
			filename: a.filename,
			contentType: a.contentType,
			isInline: a.cid !== undefined,
			data: a.content,
			contentId: a.cid,
		})),
		headers: c.headers,
		messageId: c.messageId,
		inReplyTo: c.inReplyTo,
		references: c.references,
		date: c.date,
		// Seed the boundaries so a case composes deterministically (the seed does
		// not affect PARSED equality — nodemailer uses its own random boundaries).
		boundarySeed: c.name,
	};
}

/** Adapt a corpus case to nodemailer's `MailComposer` options. */
export function toNodemailerOptions(c: CorpusCase): Mail.Options {
	const options: Mail.Options = {
		from: c.from,
		to: c.to,
		subject: c.subject,
		messageId: c.messageId,
		date: c.date,
	};
	if (c.replyTo !== undefined) options.replyTo = c.replyTo;
	if (c.cc !== undefined) options.cc = c.cc;
	if (c.bcc !== undefined) options.bcc = c.bcc;
	if (c.html !== undefined && c.html !== '') options.html = c.html;
	if (c.text !== undefined && c.text !== '') options.text = c.text;
	if (c.amp !== undefined) options.amp = c.amp;
	if (c.inReplyTo !== undefined) options.inReplyTo = c.inReplyTo;
	if (c.references !== undefined) options.references = c.references;
	if (c.headers !== undefined) options.headers = c.headers;
	if (c.attachments !== undefined) {
		options.attachments = c.attachments.map((a) => {
			const att: Mail.Attachment = {
				filename: a.filename,
				content: a.content,
				contentType: a.contentType,
			};
			if (a.cid !== undefined) {
				att.cid = a.cid;
				att.contentDisposition = 'inline';
			}
			return att;
		});
	}
	return options;
}
