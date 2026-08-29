/**
 * The always-on deterministic pre-send checks (utils/postboxPreflight) and the
 * body splitter they read (utils/postboxDraftText).
 *
 * Two properties matter more than coverage of the happy path: every finding
 * carries a KEY (never English), and no check fires on the quoted reply chain.
 */
import { describe, it, expect } from 'vitest';
import { preflightDraft } from '../postboxPreflight';
import { draftPlainText, draftTextParts } from '../postboxDraftText';

const ids = (input: { subject: string; bodyHtml: string }) =>
	preflightDraft(input).map((f) => f.id);

describe('draftPlainText', () => {
	it('drops tags and decodes the entities a composer body carries', () => {
		expect(draftPlainText('<p>Hi&nbsp;Ada &amp; Ines</p>')).toBe('Hi Ada & Ines');
		expect(draftPlainText('<p>caf&#233;</p>')).toBe('café');
		expect(draftPlainText('<p>caf&#xe9;</p>')).toBe('café');
	});

	it('never welds two words together across a tag boundary', () => {
		expect(draftPlainText('<b>at</b>tached')).toBe('at tached');
	});

	it('drops script and style contents entirely', () => {
		expect(draftPlainText('<style>a{}</style><p>hi</p>')).toBe('hi');
	});

	it('leaves an unknown entity alone rather than mangling it', () => {
		expect(draftPlainText('&notreal; x')).toBe('&notreal; x');
	});
});

describe('draftTextParts', () => {
	it('separates the fresh half from the quoted original', () => {
		const parts = draftTextParts('<p>My reply</p><blockquote><p>Their [TODO]</p></blockquote>');
		expect(parts.hasQuote).toBe(true);
		expect(parts.fresh).toBe('My reply');
		expect(parts.quoted).toContain('Their [TODO]');
	});

	it('treats a body with no quote boundary as entirely fresh', () => {
		const parts = draftTextParts('<p>Just a note</p>');
		expect(parts).toMatchObject({ fresh: 'Just a note', quoted: '', hasQuote: false });
	});
});

describe('preflightDraft', () => {
	it('is silent on a finished draft', () => {
		expect(preflightDraft({ subject: 'Q3 recap', bodyHtml: '<p>Numbers below.</p>' })).toEqual([]);
	});

	it('flags an empty subject', () => {
		expect(ids({ subject: '   ', bodyHtml: '<p>Body</p>' })).toEqual(['emptySubject']);
	});

	it('flags a leftover authoring marker and quotes it back', () => {
		const findings = preflightDraft({
			subject: 'Numbers',
			bodyHtml: '<p>Hi all. [TODO: add Q3 figure] Best</p>',
		});
		expect(findings).toEqual([
			{
				id: 'placeholder',
				key: 'shared.postbox.preflight.placeholder',
				params: { token: '[TODO: add Q3 figure]' },
			},
		]);
	});

	it('matches bare markers only in caps', () => {
		expect(ids({ subject: 'x', bodyHtml: '<p>XXX</p>' })).toEqual(['placeholder']);
		expect(ids({ subject: 'x', bodyHtml: '<p>my todo list for today</p>' })).toEqual([]);
	});

	it('flags an unfilled snippet variable by name', () => {
		const findings = preflightDraft({ subject: 'Hi', bodyHtml: '<p>Hi {{ firstName }},</p>' });
		expect(findings[0]).toEqual({
			id: 'unfilledVariable',
			key: 'shared.postbox.preflight.unfilledVariable',
			params: { name: 'firstName' },
		});
	});

	it('flags link text that names a different site than the href', () => {
		const findings = preflightDraft({
			subject: 'Invoice',
			bodyHtml: '<p><a href="https://pay-now.example/x">northwind.studio/invoice</a></p>',
		});
		expect(findings[0]).toEqual({
			id: 'linkMismatch',
			key: 'shared.postbox.preflight.linkMismatch',
			params: { text: 'northwind.studio', host: 'pay-now.example' },
		});
	});

	it('accepts www, a subdomain and a deeper path as the same site', () => {
		const same = [
			'<a href="https://www.northwind.studio/pricing">northwind.studio</a>',
			'<a href="https://eu.northwind.studio/x">northwind.studio</a>',
			'<a href="https://northwind.studio/a/b?c=1">https://northwind.studio/a/b</a>',
			'<a href="https://northwind.studio:8443/x">northwind.studio</a>',
		];
		for (const html of same) expect(ids({ subject: 'Hi', bodyHtml: html })).toEqual([]);
	});

	it('ignores links whose text names no site, and non-http hrefs', () => {
		expect(ids({ subject: 'Hi', bodyHtml: '<a href="https://x.example">click here</a>' })).toEqual(
			[]
		);
		expect(
			ids({ subject: 'Hi', bodyHtml: '<a href="mailto:ada@northwind.studio">ines.example</a>' })
		).toEqual([]);
		expect(ids({ subject: 'Hi', bodyHtml: '<a href="/local">other.example</a>' })).toEqual([]);
	});

	it('ignores an address as anchor text — it is a recipient, not a destination', () => {
		expect(
			ids({
				subject: 'Hi',
				bodyHtml: '<a href="https://x.example/p">ines@northwind.studio</a>',
			})
		).toEqual([]);
	});

	it('never fires on the quoted original', () => {
		expect(
			ids({
				subject: 'Re: numbers',
				bodyHtml:
					'<p>Sure.</p><blockquote><p>[TODO] {{firstName}} ' +
					'<a href="https://evil.example">bank.example</a></p></blockquote>',
			})
		).toEqual([]);
	});

	it('reports every failing check at once, in a stable order', () => {
		expect(
			ids({
				subject: '',
				bodyHtml: '<p>[TODO] Hi {{firstName}} <a href="https://evil.example">bank.example</a></p>',
			})
		).toEqual(['emptySubject', 'placeholder', 'unfilledVariable', 'linkMismatch']);
	});

	it('reads the subject too, and clips a long marker for display', () => {
		const findings = preflightDraft({
			subject: '[TODO: this marker is far too long to sit inside a one-line chip]',
			bodyHtml: '<p>Body</p>',
		});
		expect(findings.map((f) => f.id)).toEqual(['placeholder']);
		expect(findings[0]?.params?.token).toHaveLength(40);
		expect(findings[0]?.params?.token?.endsWith('…')).toBe(true);
	});
});
