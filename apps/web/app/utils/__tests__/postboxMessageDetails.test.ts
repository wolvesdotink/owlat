/**
 * Message-details rows (UX plan idea 52) — the panel that makes the sender
 * badge's claims checkable.
 *
 * The audit here is about ABSENCE as much as content: a check we never recorded
 * must produce no row (never a fabricated "none"), the ARC row must be
 * unreachable without the backend's own override, and every verdict must reach
 * the panel as the word the MTA stored rather than an interpretation of it.
 */
import { describe, it, expect } from 'vitest';
import { buildMessageDetailRows, domainOf } from '../postboxMessageDetails';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;
const byId = (rows: ReturnType<typeof buildMessageDetailRows>, id: string) =>
	rows.find((r) => r.id === id);

describe('buildMessageDetailRows', () => {
	it('pairs every verdict with the domain that check actually authenticated', () => {
		const rows = buildMessageDetailRows({
			fromAddress: 'hello@northwind.studio',
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			envelopeFromDomain: 'bounce.northwind.studio',
			dkimSigningDomain: 'northwind.studio',
		});
		expect(byId(rows, 'spf')).toMatchObject({
			verdict: 'pass',
			tone: 'pass',
			value: 'bounce.northwind.studio',
		});
		expect(byId(rows, 'dkim')).toMatchObject({ verdict: 'pass', value: 'northwind.studio' });
		expect(byId(rows, 'dmarc')).toMatchObject({ verdict: 'pass', value: 'northwind.studio' });
	});

	it('omits a check that was never recorded rather than inventing a verdict', () => {
		const rows = buildMessageDetailRows({
			fromAddress: 'hello@acme.com',
			spfResult: 'pass',
			envelopeFromDomain: 'acme.com',
		});
		expect(byId(rows, 'dkim')).toBeUndefined();
		expect(byId(rows, 'dmarc')).toBeUndefined();
	});

	it('says so when a verdict exists but the domain behind it does not', () => {
		const rows = buildMessageDetailRows({ fromAddress: 'hello@acme.com', dkimResult: 'pass' });
		const dkim = byId(rows, 'dkim');
		expect(dkim?.value).toBe('');
		expect(t(dkim!.note!)).toBe('no domain recorded for this check');
	});

	it('highlights a Reply-To on a different domain, and leaves a matching one alone', () => {
		const differing = buildMessageDetailRows({
			fromAddress: 'ceo@acme.com',
			replyToAddress: 'billing@other-domain.example',
		});
		expect(byId(differing, 'replyTo')).toMatchObject({ tone: 'warn' });
		expect(t(byId(differing, 'replyTo')!.note!)).toBe('different domain from the sender');

		const same = buildMessageDetailRows({
			fromAddress: 'ceo@acme.com',
			replyToAddress: 'Support <support@acme.com>',
		});
		expect(byId(same, 'replyTo')?.tone).toBe('neutral');
		expect(byId(same, 'replyTo')?.note).toBeUndefined();
	});

	it('labels the Return-Path row as the envelope domain SPF checked', () => {
		const rows = buildMessageDetailRows({
			fromAddress: 'hello@acme.com',
			envelopeFromDomain: 'bounce.acme.com',
		});
		expect(byId(rows, 'returnPath')?.value).toBe('bounce.acme.com');
		expect(t(byId(rows, 'returnPath')!.note!)).toBe(
			"the envelope sender's domain, which is what SPF checked"
		);
	});

	it('names the DMARC policy the domain published, and skips an unknown one', () => {
		const strict = buildMessageDetailRows({
			fromAddress: 'hello@acme.com',
			dmarcResult: 'fail',
			dmarcPolicy: 'reject',
		});
		expect(byId(strict, 'dmarc')?.tone).toBe('fail');
		expect(t(byId(strict, 'dmarc')!.note!)).toBe('the domain asks that failures be rejected');

		const odd = buildMessageDetailRows({
			fromAddress: 'hello@acme.com',
			dmarcResult: 'fail',
			dmarcPolicy: 'something-new',
		});
		expect(byId(odd, 'dmarc')?.note).toBeUndefined();
	});

	it('shows the ARC sealer only when the backend applied the rescue', () => {
		const ordinary = buildMessageDetailRows({
			fromAddress: 'author@example.org',
			dmarcResult: 'fail',
			arcSealer: 'lists.example',
		});
		expect(byId(ordinary, 'arc')).toBeUndefined();

		const rescued = buildMessageDetailRows({
			fromAddress: 'author@example.org',
			dmarcResult: 'fail',
			dmarcOverride: 'arc',
			arcSealer: 'lists.example',
		});
		expect(byId(rescued, 'arc')).toMatchObject({ value: 'lists.example', tone: 'pass' });
	});

	it('treats anything that is not a real outcome as neutral, never as a pass', () => {
		const rows = buildMessageDetailRows({
			fromAddress: 'hello@acme.com',
			spfResult: 'none',
			dkimResult: 'temperror',
			dmarcResult: 'softfail',
		});
		expect(byId(rows, 'spf')?.tone).toBe('neutral');
		expect(byId(rows, 'dkim')?.tone).toBe('neutral');
		expect(byId(rows, 'dmarc')?.tone).toBe('fail');
	});

	it('recomposes the From row the way the header reads it', () => {
		const named = buildMessageDetailRows({
			fromAddress: 'alice@sender.example',
			fromName: 'Alice',
		});
		expect(byId(named, 'from')?.value).toBe('Alice <alice@sender.example>');

		const bare = buildMessageDetailRows({ fromAddress: 'alice@sender.example' });
		expect(byId(bare, 'from')?.value).toBe('alice@sender.example');
	});

	it('is empty for a row that carries nothing to show', () => {
		expect(buildMessageDetailRows({ fromAddress: '' })).toEqual([]);
	});
});

describe('domainOf', () => {
	it('reads the domain out of a full header value', () => {
		expect(domainOf('Brightpath <billing@Brightpath.CO>')).toBe('brightpath.co');
	});

	it('is empty for a value with no address in it', () => {
		expect(domainOf('undisclosed-recipients')).toBe('');
		expect(domainOf(undefined)).toBe('');
	});
});
