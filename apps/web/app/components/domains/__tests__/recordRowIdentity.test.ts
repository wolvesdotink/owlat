// @vitest-environment happy-dom
/**
 * RecordRow identity + MAIL FROM label — piece B1 of the DNS Setup Revamp.
 *
 * These tests pin the domain-row's *identity* surface: the collapsed header's
 * "Sends as …" sub-line, the expanded "What this domain does" intro block, and
 * the MAIL FROM heading. The MAIL FROM assertion is an explicit regression test
 * for the old bug where the heading hardcoded `mail.<domain>` and so rendered
 * `mail.mail.example.com` for a domain added as `mail.example.com`; the heading
 * must instead name the return-path record's actual hostname.
 */
import { describe, it, expect } from 'vitest';
import { capitalize } from 'vue';
import { mount } from '@vue/test-utils';

import RecordRow from '../RecordRow.vue';

// `capitalize` is a Vue helper Nuxt auto-imports; the SFC uses it as a bare
// template global, so inject it into the render context via `global.mocks`.

const stubs = {
	Icon: { template: '<i />' },
	UiIconBox: { template: '<i />' },
	// Exercised by their own tests; inert here so we can assert the row's own copy.
	DomainsDNSRecordPanel: {
		props: ['record', 'label', 'domain', 'verification', 'coexistence'],
		template: '<div data-testid="dns-record" />',
	},
	DomainsReceivingDnsSection: { template: '<div />' },
	// Exercised by returnPathUi.test.ts; inert here (it calls a mutation on setup).
	DomainsReturnPathEditor: { template: '<div />' },
};

type DomainOverrides = Record<string, unknown>;

function makeDomain(overrides: DomainOverrides = {}) {
	return {
		_id: 'domain_1',
		domain: 'mail.example.com',
		status: 'pending',
		createdAt: Date.now(),
		verifiedAt: null,
		lastVerifiedAt: null,
		lastRegistrationError: null,
		dmarcPolicy: 'none',
		dnsRecords: {
			spf: { type: 'TXT', host: '@', value: 'v=spf1 include:_spf.owlat.test ~all' },
			dkim: [],
			dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
			// Return-path record keyed to an absolute hostname on a sibling zone —
			// deliberately NOT `mail.<domain>`, to prove the label reads the record.
			mailFrom: [
				{ type: 'TXT', hostname: 'bounce.example.com', value: 'v=spf1 ip4:203.0.113.1 -all' },
			],
		},
		verificationResults: undefined,
		...overrides,
	};
}

function mountRow(domainOverrides: DomainOverrides = {}, isExpanded = false) {
	return mount(RecordRow, {
		props: {
			domain: makeDomain(domainOverrides),
			isExpanded,
			canForceVerify: false,
			canManageDomains: true,
			isForcing: false,
			isVerifying: false,
			isUpdatingDmarc: false,
			autoRecheckActive: false,
			spfCoexistence: null,
			dmarcPolicyOptions: [{ value: 'none', label: 'None (monitor only)', hint: 'Monitor only.' }],
			showReceivingDns: false,
			inboundMailHost: null,
			inboundPort: 25,
			inboundEnabled: false,
		} as never,
		global: { stubs, mocks: { capitalize } },
	});
}

describe('RecordRow — collapsed header identity', () => {
	it('renders a "Sends as" sub-line with a concrete example address', () => {
		const w = mountRow();
		const line = w.find('[data-testid="sends-as-line"]');
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('Sends as anyone@mail.example.com');
	});

	it('names the bounce host from the actual mailFrom record hostname', () => {
		const w = mountRow();
		const line = w.find('[data-testid="sends-as-line"]');
		expect(line.text()).toContain('bounces via bounce.example.com');
		// Never a hardcoded `mail.` guess.
		expect(line.text()).not.toContain('bounces via mail.mail.example.com');
	});

	it('omits the "bounces via" segment when there is no mailFrom record', () => {
		const w = mountRow({ dnsRecords: { spf: { type: 'TXT', host: '@', value: 'v=spf1 ~all' } } });
		const line = w.find('[data-testid="sends-as-line"]');
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('Sends as anyone@mail.example.com');
		expect(line.text()).not.toContain('bounces via');
	});

	it('keeps the existing added-date info on the combined hint line', () => {
		const line = mountRow().find('[data-testid="sends-as-line"]');
		// Sends-as, bounce host and status/date all live on one line (§3.1 mock).
		expect(line.text()).toContain('Sends as anyone@mail.example.com');
		expect(line.text()).toContain('bounces via bounce.example.com');
		// The status/date segment reads mid-sentence after the `·`, so it is
		// lowercased — pin that casing so no branch reverts to "Added".
		expect(line.text()).toContain('· added');
		expect(line.text()).not.toContain('Added');
	});

	it('lowercases the registering status branch to match the sibling branches', () => {
		const line = mountRow({ status: 'registering' }).find('[data-testid="sends-as-line"]');
		expect(line.text()).toContain('· setting up domain…');
		expect(line.text()).not.toContain('Setting up domain');
	});

	it('composes a relative SES-style host (host:"mail", no hostname) against the domain', () => {
		// The SES provider emits mailFrom records with a relative `host: 'mail'`
		// and no `hostname`; the bounce host must resolve to mail.<domain>, never
		// a bare "mail" label.
		const w = mountRow({
			domain: 'example.com',
			dnsRecords: {
				spf: { type: 'TXT', host: '@', value: 'v=spf1 ~all' },
				mailFrom: [
					{
						type: 'MX',
						host: 'mail',
						value: 'feedback-smtp.us-east-1.amazonses.com',
						priority: 10,
					},
					{ type: 'TXT', host: 'mail', value: 'v=spf1 include:amazonses.com ~all' },
				],
			},
		});
		const line = w.find('[data-testid="sends-as-line"]');
		expect(line.text()).toContain('bounces via mail.example.com');
		expect(line.text()).not.toMatch(/bounces via mail(?![.])/);
	});
});

describe('RecordRow — MAIL FROM heading (regression: mail.mail.example.com)', () => {
	it('labels MAIL FROM with the record hostname, not mail.<domain>', () => {
		const w = mountRow({}, true);
		const heading = w.find('[data-testid="mailfrom-heading"]');
		expect(heading.exists()).toBe(true);
		expect(heading.text()).toContain('MAIL FROM Domain (bounce.example.com)');
		// The old hardcoded-prefix bug produced this for a `mail.example.com` domain.
		expect(heading.text()).not.toContain('mail.mail.example.com');
	});

	it('composes a relative SES-style host in the heading (mail.<domain>)', () => {
		const w = mountRow(
			{
				domain: 'example.com',
				dnsRecords: {
					spf: { type: 'TXT', host: '@', value: 'v=spf1 ~all' },
					mailFrom: [
						{
							type: 'MX',
							host: 'mail',
							value: 'feedback-smtp.us-east-1.amazonses.com',
							priority: 10,
						},
						{ type: 'TXT', host: 'mail', value: 'v=spf1 include:amazonses.com ~all' },
					],
				},
			},
			true
		);
		const heading = w.find('[data-testid="mailfrom-heading"]');
		expect(heading.text()).toContain('MAIL FROM Domain (mail.example.com)');
	});

	it('drops the parenthetical when the mailFrom record carries no host or hostname', () => {
		const w = mountRow(
			{
				dnsRecords: {
					spf: { type: 'TXT', host: '@', value: 'v=spf1 ~all' },
					mailFrom: [{ type: 'TXT', value: 'v=spf1 -all' }],
				},
			},
			true
		);
		const heading = w.find('[data-testid="mailfrom-heading"]');
		expect(heading.exists()).toBe(true);
		expect(heading.text().trim()).toBe('MAIL FROM Domain');
	});
});

describe('RecordRow — expanded "What this domain does" intro', () => {
	it('renders the intro block only when expanded', () => {
		expect(mountRow({}, false).find('[data-testid="domain-intro"]').exists()).toBe(false);
		expect(mountRow({}, true).find('[data-testid="domain-intro"]').exists()).toBe(true);
	});

	it('states the sending identity and the load-bearing "not a website" copy', () => {
		const intro = mountRow({}, true).find('[data-testid="domain-intro"]');
		const text = intro.text();
		expect(text).toContain('name@mail.example.com');
		expect(text).toContain('nothing needs to be hosted at this name');
		// Apex reassurance names the A1-derived registrable zone.
		expect(text).toContain("won't affect your website at example.com");
	});

	it('uses the domain as-is for the apex mention on an apex domain', () => {
		const intro = mountRow({ domain: 'example.com' }, true).find('[data-testid="domain-intro"]');
		expect(intro.text()).toContain("won't affect your website at example.com");
		expect(intro.text()).toContain('name@example.com');
	});

	// Regression: the intro apex must come from the A1 PSL zone, not a hand-rolled
	// label slice — the two disagreed exactly where A1 matters (F1 cross-piece bug).
	it('names the registrable zone (not the public suffix) on a multi-label suffix', () => {
		const intro = mountRow({ domain: 'example.co.uk' }, true).find('[data-testid="domain-intro"]');
		expect(intro.text()).toContain("won't affect your website at example.co.uk");
		// The old slice named the bare public suffix `co.uk`.
		expect(intro.text()).not.toContain("won't affect your website at co.uk");
	});

	it('names the registrable zone (not a mid subdomain) on a deep subdomain', () => {
		const intro = mountRow({ domain: 'a.b.example.com' }, true).find(
			'[data-testid="domain-intro"]'
		);
		expect(intro.text()).toContain("won't affect your website at example.com");
		// The old slice dropped only the leftmost label → `b.example.com`. Anchor to
		// the copy phrase (the sends-as line legitimately contains `a.b.example.com`).
		expect(intro.text()).not.toContain("won't affect your website at b.example.com");
	});
});
