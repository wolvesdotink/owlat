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

/** The kinds the shipped panel's query can speak for — `RelayDomainStatus.vue`. */
const SES_PANEL = ['ses'];

describe('relayIdentityPanelVisible', () => {
	it('hides the panel from a deployment with no escape-hatch relay configured', () => {
		expect(relayIdentityPanelVisible([noIdentity, noIdentity], [], SES_PANEL)).toBe(false);
		expect(relayIdentityPanelVisible([awaitingPrimary], [], SES_PANEL)).toBe(false);
	});

	it('hides it when the configured relay verifies no domains through an API', () => {
		// `resend` and `smtp` both declare `domainVerification: 'none'`: there is
		// no identity to publish records for, so the instruction would be a lie.
		expect(relayIdentityPanelVisible([noIdentity], ['resend'], SES_PANEL)).toBe(false);
		expect(relayIdentityPanelVisible([noIdentity], ['smtp'], SES_PANEL)).toBe(false);
	});

	it('shows it while an api-verified relay it answers for is being provisioned', () => {
		// The card's whole job: "publish these records before automatic fallback
		// can activate", said before the first identity row exists.
		expect(relayIdentityPanelVisible([noIdentity], ['ses'], SES_PANEL)).toBe(true);
	});

	it('hides it from an api-verified relay whose rows this query cannot see', () => {
		// THE HALF-FIX THIS PINS. Mandrill declares the same
		// `domainVerification: 'api'` capability, so a gate that asked the
		// capability ALONE showed the SES-worded card — "SES status: provisioning"
		// — to a deployment whose only escape hatch is Mandrill, beside the
		// Mandrill panel that was already rendering its real rows. The capability
		// makes the sentence true; the kind makes it true of THIS panel.
		expect(relayIdentityPanelVisible([noIdentity], ['mandrill'], SES_PANEL)).toBe(false);
		expect(relayIdentityPanelVisible([noIdentity], ['mandrill', 'ses'], SES_PANEL)).toBe(true);
		expect(relayIdentityPanelVisible([noIdentity], ['not-a-transport'], SES_PANEL)).toBe(false);
	});

	it('asks the capability, not the name, of the kinds it does answer for', () => {
		// The generic `sendingDomainRelayIdentities` read hands this gate the set of
		// kinds it can prove; every one of them is still admitted on its DECLARATION
		// rather than on being called `ses`, and a `none` kind in that set is
		// refused all the same.
		expect(relayIdentityPanelVisible([noIdentity], ['mandrill'], ['ses', 'mandrill'])).toBe(true);
		expect(relayIdentityPanelVisible([noIdentity], ['resend'], ['ses', 'resend'])).toBe(false);
	});

	it('keeps published identity state visible after the hatch is switched off', () => {
		// A row that carries DNS records, or a status only an identity row can
		// produce, is state the operator published and must still be able to read.
		expect(relayIdentityPanelVisible([{ status: 'verified' }], [], SES_PANEL)).toBe(true);
		expect(relayIdentityPanelVisible([{ status: 'pending' }], [], SES_PANEL)).toBe(true);
		expect(relayIdentityPanelVisible([{ status: 'stale' }], [], SES_PANEL)).toBe(true);
		expect(
			relayIdentityPanelVisible(
				[{ status: 'awaiting_primary_verification', dnsRecords: {} }],
				[],
				SES_PANEL
			)
		).toBe(true);
	});

	it('renders nothing when there are no owned domains at all', () => {
		expect(relayIdentityPanelVisible([], ['ses'], SES_PANEL)).toBe(false);
		expect(relayIdentityPanelVisible(undefined, ['ses'], SES_PANEL)).toBe(false);
	});
});
