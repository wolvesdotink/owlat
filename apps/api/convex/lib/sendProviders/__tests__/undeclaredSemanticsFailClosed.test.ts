/**
 * THE FAIL-CLOSED DEFAULTS OF THE TWO DISPATCH SEMANTICS (plan P0.1 / D2).
 *
 * `acceptanceSemanticsFor` and `messageIdSourceFor` each apply a default to an
 * entry that declared nothing, and the safety of the whole seam rests on WHICH
 * default: an entry read as `accepted` would report `isCustodyHandoff` for a
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
 *  - `partial` declares ONE of the two and leaves the other to its default.
 *    `CoreSendProviderCatalogEntry` makes the pair inseparable for a kind
 *    shipping in this repo, but this tier is untyped, so the accessors must keep
 *    reading the two fields independently rather than rounding one to the other
 *    or discarding a declaration that arrived without its twin.
 *
 * Neither declares `accepted` or `idempotency-key`: those are refused outright
 * for this tier by the composition-time guard in `catalog.ts`, which
 * `pluginCustodyGuard.test.ts` covers.
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
			kind: 'plugin.mail-pack.partial',
			pluginId: 'mail-pack',
			localId: 'partial',
			label: 'Partially declared transport',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
			messageIdSource: 'composed',
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
const PARTIAL = 'plugin.mail-pack.partial' as SendProviderKind;

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

describe('an untyped entry that declares only one of the two', () => {
	it('is read field by field — the declared one stands, the absent one defaults', () => {
		// The two fields are a PAIR only in the core type. At runtime they are read
		// independently, so a half-declared entry must not have its declaration
		// discarded for arriving alone, nor its silence filled in from its twin.
		expect(sendProviderCatalogEntry(PARTIAL).acceptanceSemantics).toBeUndefined();
		expect(messageIdSourceFor(PARTIAL)).toBe('composed');
		expect(preassignsProviderMessageId(messageIdSourceFor(PARTIAL))).toBe(false);
		expect(acceptanceSemanticsFor(PARTIAL)).toBe('unknown-on-timeout');
		expect(takesCustodyOnAcceptance(acceptanceSemanticsFor(PARTIAL))).toBe(false);
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
