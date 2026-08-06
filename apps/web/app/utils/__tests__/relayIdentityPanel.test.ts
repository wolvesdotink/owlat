/**
 * WHO SEES THE RELAY-IDENTITY PANEL.
 *
 * The bug this gate closes is concrete: the query behind the panel answers for
 * every OWNED sending domain, and synthesises `provisioning` for any domain with
 * no identity row. A deployment sending through Resend, with one verified owned
 * domain and no SES account at all, therefore saw a card headed "SES
 * escape-hatch domains" telling it to refresh and wait for a provisioning run
 * nobody had asked for.
 */
import { describe, expect, it } from 'vitest';
import { relayIdentityPanelVisible } from '../relayIdentityPanel';

const noIdentity = { status: 'provisioning' } as const;
const awaitingPrimary = { status: 'awaiting_primary_verification' } as const;

describe('relayIdentityPanelVisible', () => {
	it('hides the panel from a deployment with no escape-hatch relay configured', () => {
		expect(relayIdentityPanelVisible([noIdentity, noIdentity], [])).toBe(false);
		expect(relayIdentityPanelVisible([awaitingPrimary], [])).toBe(false);
	});

	it('hides it when the configured relay verifies no domains through an API', () => {
		// `resend` and `smtp` both declare `domainVerification: 'none'`: there is
		// no identity to publish records for, so the instruction would be a lie.
		expect(relayIdentityPanelVisible([noIdentity], ['resend'])).toBe(false);
		expect(relayIdentityPanelVisible([noIdentity], ['smtp'])).toBe(false);
	});

	it('shows it while an api-verified relay is being provisioned', () => {
		// The card's whole job: "publish these records before automatic fallback
		// can activate", said before the first identity row exists.
		expect(relayIdentityPanelVisible([noIdentity], ['ses'])).toBe(true);
	});

	it('asks the capability, not the name', () => {
		// Mandrill declares the same capability, and this gate cannot tell the two
		// apart — which is the point. (Its rows are rendered by its own panel; the
		// copy here still speaks for the SES table, and that is the backend change
		// recorded in scripts/provider-identity-allowlist.txt.)
		expect(relayIdentityPanelVisible([noIdentity], ['mandrill'])).toBe(true);
		expect(relayIdentityPanelVisible([noIdentity], ['not-a-transport'])).toBe(false);
	});

	it('keeps published identity state visible after the hatch is switched off', () => {
		// A row that carries DNS records, or a status only an identity row can
		// produce, is state the operator published and must still be able to read.
		expect(relayIdentityPanelVisible([{ status: 'verified' }], [])).toBe(true);
		expect(relayIdentityPanelVisible([{ status: 'pending' }], [])).toBe(true);
		expect(relayIdentityPanelVisible([{ status: 'stale' }], [])).toBe(true);
		expect(
			relayIdentityPanelVisible([{ status: 'awaiting_primary_verification', dnsRecords: {} }], [])
		).toBe(true);
	});

	it('renders nothing when there are no owned domains at all', () => {
		expect(relayIdentityPanelVisible([], ['ses'])).toBe(false);
		expect(relayIdentityPanelVisible(undefined, ['ses'])).toBe(false);
	});
});
