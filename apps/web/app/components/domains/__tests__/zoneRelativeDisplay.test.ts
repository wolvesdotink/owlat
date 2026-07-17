/**
 * Hard test gate for piece C1 — zone-aware host display in DNSRecordPanel.
 *
 * Asserts the primary copy target is the name relative to the domain's
 * registrable zone and the full FQDN is offered as a secondary copy, for every
 * record type; that an apex SPF record shows `@`; that a mailFrom record keyed to
 * an absolute env hostname outside the domain's zone is shown honestly (absolute
 * name, no `host.domain` double-suffix, an "other zone" note) rather than
 * mis-relativised; and that the "Fixed by standard" pill appears on exactly the
 * RFC-mandated cards (_dmarc / _domainkey / _smtp._tls / _mta-sts) and nowhere
 * else.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

// `useCopyToClipboard` is a Nuxt auto-import referenced as a bare global; stub it
// before the component module is evaluated (mirrors DNSRecordPanel.test.ts).
beforeAll(() => {
	vi.stubGlobal('useCopyToClipboard', () => ({
		copy: vi.fn(),
		isCopied: () => false,
		copiedKey: ref(null),
		reset: vi.fn(),
	}));
});

import DNSRecordPanel from '../DNSRecordPanel.vue';

function mountPanel(
	record: { type: string; host: string; value: string },
	domain: string,
	label: string
) {
	return mount(DNSRecordPanel, {
		props: { record, label, domain },
		global: { stubs: { Icon: true } },
	});
}

const primary = (w: ReturnType<typeof mountPanel>) =>
	w.find('[data-testid="dns-host-primary"]').text();
const fqdn = (w: ReturnType<typeof mountPanel>) => {
	const el = w.find('[data-testid="dns-host-fqdn"]');
	return el.exists() ? el.text() : null;
};
const hasPill = (w: ReturnType<typeof mountPanel>) =>
	w.find('[data-testid="dns-standard-pill"]').exists();
const hasHint = (w: ReturnType<typeof mountPanel>) =>
	w.find('[data-testid="dns-provider-hint"]').exists();

describe('zone-relative primary vs FQDN secondary — per record type', () => {
	it('apex SPF on a registrable domain shows @ with the FQDN secondary', () => {
		const w = mountPanel(
			{ type: 'TXT', host: '@', value: 'v=spf1 include:_spf.owlat.test ~all' },
			'example.com',
			'SPF'
		);
		expect(primary(w)).toBe('@');
		expect(fqdn(w)).toBe('example.com');
		expect(hasHint(w)).toBe(true);
		expect(hasPill(w)).toBe(false);
	});

	it('SPF on a sending SUBDOMAIN is relative to the registrable zone', () => {
		// host '@' but the sending domain is a subdomain: the TXT lives at
		// mail.example.com, which is `mail` relative to the zone example.com.
		const w = mountPanel(
			{ type: 'TXT', host: '@', value: 'v=spf1 ~all' },
			'mail.example.com',
			'SPF'
		);
		expect(primary(w)).toBe('mail');
		expect(fqdn(w)).toBe('mail.example.com');
		expect(hasPill(w)).toBe(false);
	});

	it('DKIM CNAME collapses the zone suffix and carries the standard pill', () => {
		const w = mountPanel(
			{ type: 'CNAME', host: 's1711234567._domainkey', value: 's1711234567.dkim.owlat.test' },
			'mail.example.com',
			'DKIM 1'
		);
		expect(primary(w)).toBe('s1711234567._domainkey.mail');
		expect(fqdn(w)).toBe('s1711234567._domainkey.mail.example.com');
		expect(hasPill(w)).toBe(true);
	});

	it('DMARC TXT is relative and carries the standard pill', () => {
		const w = mountPanel(
			{ type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
			'example.com',
			'DMARC'
		);
		expect(primary(w)).toBe('_dmarc');
		expect(fqdn(w)).toBe('_dmarc.example.com');
		expect(hasPill(w)).toBe(true);
	});

	it('TLS-RPT (_smtp._tls) carries the standard pill', () => {
		const w = mountPanel(
			{ type: 'TXT', host: '_smtp._tls', value: 'v=TLSRPTv1; rua=mailto:tls@example.com' },
			'example.com',
			'TLS-RPT'
		);
		expect(primary(w)).toBe('_smtp._tls');
		expect(hasPill(w)).toBe(true);
	});

	it('MTA-STS TXT (_mta-sts) carries the standard pill', () => {
		const w = mountPanel(
			{ type: 'TXT', host: '_mta-sts', value: 'v=STSv1; id=20260717' },
			'example.com',
			'TXT'
		);
		expect(primary(w)).toBe('_mta-sts');
		expect(hasPill(w)).toBe(true);
	});

	it('MTA-STS CNAME (mta-sts, no underscore) does NOT carry the pill', () => {
		const w = mountPanel(
			{ type: 'CNAME', host: 'mta-sts', value: 'mta-sts.owlat.test' },
			'example.com',
			'CNAME'
		);
		expect(primary(w)).toBe('mta-sts');
		expect(hasPill(w)).toBe(false);
	});

	it('inbound MX at the apex shows @ and no pill', () => {
		const w = mountPanel({ type: 'MX', host: '@', value: 'mx.owlat.test' }, 'example.com', 'MX');
		expect(primary(w)).toBe('@');
		expect(hasPill(w)).toBe(false);
	});

	it('tracking CNAME shows the branded label relative to the zone, no pill', () => {
		const w = mountPanel(
			{ type: 'CNAME', host: '@', value: 'track.owlat.test' },
			'track.example.com',
			'Tracking'
		);
		expect(primary(w)).toBe('track');
		expect(fqdn(w)).toBe('track.example.com');
		expect(hasPill(w)).toBe(false);
	});
});

describe('mailFrom absolute hostname — in-zone vs out-of-zone', () => {
	it('a per-domain return-path host inside the zone is relativised', () => {
		// normalizeDnsRecord passes an absolute hostname through as `host`.
		const w = mountPanel(
			{ type: 'TXT', host: 'bounce.example.com', value: 'v=spf1 include:_spf.owlat.test -all' },
			'mail.example.com',
			'MAIL FROM SPF'
		);
		expect(primary(w)).toBe('bounce');
		expect(fqdn(w)).toBe('bounce.example.com');
		expect(hasPill(w)).toBe(false);
		expect(w.find('[data-testid="dns-out-of-zone"]').exists()).toBe(false);
	});

	it('a shared return-path host OUTSIDE the zone is shown absolutely, not doubled', () => {
		const w = mountPanel(
			{ type: 'TXT', host: 'bounces.owlat.com', value: 'v=spf1 include:_spf.owlat.test -all' },
			'example.com',
			'MAIL FROM SPF'
		);
		// The classic bug is `${host}.${domain}` → bounces.owlat.com.example.com.
		expect(primary(w)).toBe('bounces.owlat.com');
		expect(primary(w)).not.toContain('.example.com');
		// No misleading zone-relative form or FQDN secondary; instead an honest note.
		expect(fqdn(w)).toBeNull();
		const note = w.find('[data-testid="dns-out-of-zone"]');
		expect(note.exists()).toBe(true);
		expect(note.text()).toContain('owlat.com');
		expect(hasPill(w)).toBe(false);
	});
});

describe('the standard pill appears on exactly the mandated cards', () => {
	const cases: Array<[string, string, boolean]> = [
		// [host, domain, expectPill]
		['@', 'example.com', false], // SPF apex
		['s1._domainkey', 'example.com', true], // DKIM
		['_dmarc', 'example.com', true], // DMARC
		['_smtp._tls', 'example.com', true], // TLS-RPT
		['_mta-sts', 'example.com', true], // MTA-STS TXT
		['mta-sts', 'example.com', false], // MTA-STS CNAME
		['bounces.owlat.com', 'example.com', false], // mailFrom (out of zone)
		['bounce.example.com', 'example.com', false], // mailFrom (in zone)
	];
	it.each(cases)('host %s / domain %s → pill=%s', (host, domain, expected) => {
		const w = mountPanel({ type: 'TXT', host, value: 'x' }, domain, 'R');
		expect(hasPill(w)).toBe(expected);
	});
});
