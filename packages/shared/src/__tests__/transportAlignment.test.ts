import { describe, expect, it } from 'vitest';
import {
	checkFromAlignment,
	summarizeOutboundAlignment,
	type OutboundTransportFacts,
} from '../transportAlignment';

const mta = (over: Partial<OutboundTransportFacts> = {}): OutboundTransportFacts => ({
	kind: 'mta',
	returnPathDomain: null,
	dkimDomain: null,
	...over,
});

const relay = (over: Partial<OutboundTransportFacts> = {}): OutboundTransportFacts => ({
	kind: 'smtp',
	returnPathDomain: null,
	dkimDomain: null,
	...over,
});

describe('checkFromAlignment — built-in MTA', () => {
	it('aligns by construction (signs/bounces per From-domain) with no identities declared', () => {
		const r = checkFromAlignment('acme.com', mta());
		expect(r.state).toBe('aligned');
		expect(r.reason).toBeNull();
	});

	it('still aligns when the return-path is a shared bounce domain — DKIM carries it', () => {
		// The documented shared-bounce-domain case: SPF can\'t align but per-domain
		// DKIM does, so DMARC passes.
		const r = checkFromAlignment('acme.com', mta({ returnPathDomain: 'bounces.owlat.com' }));
		expect(r.state).toBe('aligned');
	});

	it('is misaligned only when BOTH a foreign d= and a foreign return-path are declared', () => {
		const r = checkFromAlignment(
			'acme.com',
			mta({ dkimDomain: 'owlat.com', returnPathDomain: 'bounces.owlat.com' })
		);
		expect(r.state).toBe('misaligned');
		expect(r.reason).toContain('owlat.com');
		expect(r.reason).toContain('acme.com');
	});

	it('is unknown (not aligned) when d= is a foreign domain and the return-path is undeclared', () => {
		// The MTA's default return-path is a SHARED VERP bounce domain that does
		// NOT align per From-domain, so an undeclared return-path can't rescue a
		// declared-foreign d=. Only the DKIM identity gets the per-From-domain
		// default; the return-path stays `null` (unknown), so the verdict is
		// `unknown` — never a claimed alignment we didn't verify.
		const r = checkFromAlignment('acme.com', mta({ dkimDomain: 'owlat.com' }));
		expect(r.state).toBe('unknown');
	});
});

describe('checkFromAlignment — SMTP relay', () => {
	it('is misaligned when the relay signs and bounces as its own foreign domain', () => {
		const r = checkFromAlignment(
			'acme.com',
			relay({ dkimDomain: 'sendgrid.net', returnPathDomain: 'sendgrid.net' })
		);
		expect(r.state).toBe('misaligned');
		expect(r.reason).toContain('sendgrid.net');
	});

	it('aligns when the relay is configured to sign as the sending domain (relaxed)', () => {
		const r = checkFromAlignment(
			'mail.acme.com',
			relay({ dkimDomain: 'acme.com', returnPathDomain: 'bounce.acme.com' })
		);
		expect(r.state).toBe('aligned');
	});

	it('is unknown — never a claimed problem — when the relay identities are undeclared', () => {
		const r = checkFromAlignment('acme.com', relay());
		expect(r.state).toBe('unknown');
		expect(r.reason).toContain('acme.com');
	});

	it('is unknown (not misaligned) when only the return-path is foreign and DKIM is undeclared', () => {
		// DKIM might still align — we didn\'t check it, so we must not claim a failure.
		const r = checkFromAlignment('acme.com', relay({ returnPathDomain: 'sendgrid.net' }));
		expect(r.state).toBe('unknown');
	});
});

describe('checkFromAlignment — degenerate input', () => {
	it('is unknown with an empty From-domain', () => {
		expect(checkFromAlignment('', relay()).state).toBe('unknown');
	});
});

describe('summarizeOutboundAlignment', () => {
	it('flags only the definitely-misaligned domains and carries the first reason', () => {
		const facts = relay({ dkimDomain: 'sendgrid.net', returnPathDomain: 'sendgrid.net' });
		const summary = summarizeOutboundAlignment(['acme.com', 'widgets.io'], facts);
		expect(summary.misaligned).toBe(true);
		expect(summary.misalignedDomains).toEqual(['acme.com', 'widgets.io']);
		expect(summary.reason).toContain('sendgrid.net');
	});

	it('does not flag unknown (undeclared-relay) domains', () => {
		const summary = summarizeOutboundAlignment(['acme.com'], relay());
		expect(summary.misaligned).toBe(false);
		expect(summary.misalignedDomains).toEqual([]);
		expect(summary.reason).toBeNull();
	});

	it('is clean for the built-in MTA', () => {
		const summary = summarizeOutboundAlignment(['acme.com', 'widgets.io'], mta());
		expect(summary.misaligned).toBe(false);
	});
});
