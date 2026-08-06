/**
 * THE FAIL-CLOSED DEFAULTS OF THE TWO DISPATCH SEMANTICS (plan P0.1 / D2).
 *
 * `acceptanceSemanticsFor` and `messageIdSourceFor` each apply a default to an
 * entry that declared nothing, and the safety of the whole seam rests on WHICH
 * default: an entry read as `accepted` would report `acceptedForDelivery` for a
 * transport that never took custody, and one read as `idempotency-key` would get
 * an identity pre-bound under an id the provider never saw and would answer an
 * ambiguous send by REPLAYING it into a transport with no idempotency surface —
 * a double delivery.
 *
 * No SHIPPED entry can exercise those defaults: `CoreSendProviderCatalogEntry`
 * makes both fields required for the five core kinds, and the generated bundled
 * plugin catalog is empty in this build. A loop over the real catalog therefore
 * asserts nothing about them — flipping either default would leave the whole api
 * suite green. So this file supplies the missing entries by mocking the
 * generated catalog (the pattern `unknownTransportFailsClosed.test.ts` and
 * `pluginDispatch.integration.test.ts` already use) and pins the defaults
 * directly. `dispatchExtras.test.ts` keeps the real-catalog pins; it mocks
 * nothing, deliberately, and the two files are complementary for that reason.
 */

import { describe, expect, it, vi } from 'vitest';

/**
 * Two bundled plugin transports, both shapes a plugin manifest can really
 * produce today or under plan P3.1:
 *
 *  - `undeclared` declares NEITHER semantic — the shape every bundled entry has
 *    right now, since manifests carry no semantics surface at all.
 *  - `mixed` declares an id of ours WITHOUT custody. `CoreSendProviderCatalogEntry`
 *    forbids that pairing for a kind shipping in this repo, but this tier is
 *    untyped, so the accessors must keep reading the two fields independently
 *    rather than rounding one to the other.
 */
vi.mock('../../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.undeclared',
			pluginId: 'mail-pack',
			localId: 'undeclared',
			label: 'Undeclared transport',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
		}),
		Object.freeze({
			kind: 'plugin.mail-pack.mixed',
			pluginId: 'mail-pack',
			localId: 'mixed',
			label: 'Mixed-declaration transport',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
			acceptanceSemantics: 'unknown-on-timeout',
			messageIdSource: 'idempotency-key',
		}),
	]),
}));

import {
	acceptanceSemanticsFor,
	messageIdSourceFor,
	preassignsProviderMessageId,
	sendProviderCatalogEntry,
	takesCustodyOnAcceptance,
	type SendProviderKind,
} from '../catalog';

const UNDECLARED = 'plugin.mail-pack.undeclared' as SendProviderKind;
const MIXED = 'plugin.mail-pack.mixed' as SendProviderKind;

describe('an entry that declares neither dispatch semantic', () => {
	it('really declares neither — so the defaults are what the accessors answered', () => {
		// Without this the assertions below could be passing because the entry
		// happens to declare the same values, proving nothing about the defaults.
		const entry = sendProviderCatalogEntry(UNDECLARED);
		expect(entry.acceptanceSemantics).toBeUndefined();
		expect(entry.messageIdSource).toBeUndefined();
	});

	it('takes NO custody — an absent declaration is never `accepted`', () => {
		expect(acceptanceSemanticsFor(UNDECLARED)).toBe('unknown-on-timeout');
		expect(takesCustodyOnAcceptance(acceptanceSemanticsFor(UNDECLARED))).toBe(false);
	});

	it('has an id we do NOT control — an absent declaration is never ours', () => {
		expect(messageIdSourceFor(UNDECLARED)).toBe('provider');
		expect(preassignsProviderMessageId(messageIdSourceFor(UNDECLARED))).toBe(false);
	});
});

describe('an untyped entry with a mixed pairing', () => {
	it('is read field by field — custody is not inferred from owning the id', () => {
		expect(messageIdSourceFor(MIXED)).toBe('idempotency-key');
		expect(preassignsProviderMessageId(messageIdSourceFor(MIXED))).toBe(true);
		expect(acceptanceSemanticsFor(MIXED)).toBe('unknown-on-timeout');
		expect(takesCustodyOnAcceptance(acceptanceSemanticsFor(MIXED))).toBe(false);
	});
});

describe('the derivations, applied to a declaration rather than to a kind', () => {
	// They take the declared VALUE precisely so a caller cannot reach the pair's
	// two halves by two different routes, and so a test can steer the lookup
	// without also restating the rule (see `delivery/__tests__/governedDispatch.test.ts`).
	it.each([
		{ source: 'idempotency-key', preassigned: true },
		{ source: 'provider', preassigned: false },
		{ source: 'composed', preassigned: false },
	] as const)('$source is pre-assigned: $preassigned', ({ source, preassigned }) => {
		expect(preassignsProviderMessageId(source)).toBe(preassigned);
	});

	it.each([
		{ semantics: 'accepted', custody: true },
		{ semantics: 'unknown-on-timeout', custody: false },
	] as const)('$semantics means custody: $custody', ({ semantics, custody }) => {
		expect(takesCustodyOnAcceptance(semantics)).toBe(custody);
	});
});
