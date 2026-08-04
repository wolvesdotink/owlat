/**
 * THE RELAY LIST, ASKED ABOUT A NEW TRANSPORT (P1.3, plan D8).
 *
 * `relayConfiguration.ts` is the ONE reading of "which transports are the second
 * arm", and seven readers take their answer from it: the alignment pre-flight
 * builds the reference arm from it, the ramp's enrolment fork and its reset door
 * ask whether a second sender exists at all, the dashboard and the independence
 * and return-path reads ask which one it is. It is written to be kind-agnostic —
 * it looks for "enabled and not `mta`" and never names a provider — and that is
 * exactly the kind of code whose genericity nobody notices breaking, because a
 * relay it fails to see does not error: the deployment simply reads as
 * STANDALONE. Every gate then grades a two-arm deployment with the one-arm
 * evaluator, the ramp opens at the standalone share, and the numbers stay
 * plausible the whole time.
 *
 * So the migration's transport is asked for explicitly, through both of the
 * surfaces the list is built from — a `providerRoutes` row and the
 * single-transport `EMAIL_PROVIDER` env — and the "exactly one" rule that turns
 * that list into a reference arm is pinned on both sides of its boundary.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { modules } from '../../__tests__/testModules';
import {
	configuredRelayKinds,
	referenceRelayTransportId,
	relayConfiguration,
} from '../relayConfiguration';

const NOW = 1_800_000_000_000;

type Harness = TestConvex<typeof schema>;

/**
 * A route naming the transports it enables. The own MTA is included in every
 * fixture, because the migration shape is a HYBRID: a relay list that only
 * looked right when the MTA was absent would be right for no real deployment.
 */
async function seedRoute(
	t: Harness,
	options: {
		messageType?: 'campaign' | 'transactional';
		providers: ReadonlyArray<{ providerType: string; isEnabled: boolean }>;
	}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: options.messageType ?? 'campaign',
			strategy: 'adaptive_mix',
			providers: options.providers.map((provider) => ({ ...provider })),
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

function read(t: Harness) {
	return t.run(async (ctx) => ({
		kinds: await configuredRelayKinds(ctx),
		referenceTransportId: await referenceRelayTransportId(ctx),
		configuration: await relayConfiguration(ctx),
	}));
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('configuredRelayKinds discovers Mandrill', () => {
	it('finds it in a providerRoutes row and names it the single reference arm', async () => {
		// The measured-migration shape from the activation matrix.
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		const t = convexTest(schema, modules);
		await seedRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'mandrill', isEnabled: true },
			],
		});

		expect(await read(t)).toEqual({
			kinds: ['mandrill'],
			referenceTransportId: 'mandrill',
			configuration: { referenceTransportId: 'mandrill', isRelayConfigured: true },
		});
	});

	it('finds it in EMAIL_PROVIDER with no route rows at all — the day-0 arrival', async () => {
		// The activation matrix's first row: `EMAIL_PROVIDER=mandrill`, nothing in
		// `providerRoutes`, everything relaying through the account they came with.
		vi.stubEnv('EMAIL_PROVIDER', 'mandrill');
		const t = convexTest(schema, modules);

		expect(await read(t)).toEqual({
			kinds: ['mandrill'],
			referenceTransportId: 'mandrill',
			configuration: { referenceTransportId: 'mandrill', isRelayConfigured: true },
		});
	});

	it('does not count a DISABLED Mandrill entry, and never counts the own MTA', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		const t = convexTest(schema, modules);
		await seedRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'mandrill', isEnabled: false },
			],
		});

		// Zero relays is the STANDALONE configuration (D2) — a supported one, and
		// the answer a disabled relay must give rather than a phantom second arm.
		expect(await read(t)).toEqual({
			kinds: [],
			referenceTransportId: null,
			configuration: { referenceTransportId: null, isRelayConfigured: false },
		});
	});

	it('de-duplicates one kind reached through both surfaces', async () => {
		// A day-0 deployment that later writes a route still has ONE second arm;
		// counting the env and the row separately would make it look like two and
		// silently strip the reference id every reader is keyed on.
		vi.stubEnv('EMAIL_PROVIDER', 'mandrill');
		const t = convexTest(schema, modules);
		await seedRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'mandrill', isEnabled: true },
			],
		});

		expect(await read(t)).toMatchObject({
			kinds: ['mandrill'],
			referenceTransportId: 'mandrill',
		});
	});
});

describe('more than one relay has no single second arm (D8)', () => {
	it('lists both kinds and refuses to name a reference transport', async () => {
		// The configuration the plan tells a migrating operator to avoid: keep
		// Mandrill the only non-MTA kind in routes, or alignment confidence
		// degrades. "Degrades" is this: there is still a second sender — the ramp's
		// doors stay open — but no single arm the measurement can be against, so
		// every reader that needs to NAME one gets null.
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		const t = convexTest(schema, modules);
		await seedRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'mandrill', isEnabled: true },
			],
		});
		await seedRoute(t, {
			messageType: 'transactional',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'resend', isEnabled: true },
			],
		});

		expect(await read(t)).toEqual({
			// Sorted, so the list is stable for the operator-facing copy that joins it.
			kinds: ['mandrill', 'resend'],
			referenceTransportId: null,
			configuration: { referenceTransportId: null, isRelayConfigured: true },
		});
	});

	it('counts the env transport as a SECOND relay beside a routed Mandrill', async () => {
		// The accidental version of the same shape: a deployment that migrated its
		// campaign route to Mandrill while `EMAIL_PROVIDER` still names the relay it
		// arrived on. Nothing errors; the reference arm simply disappears.
		vi.stubEnv('EMAIL_PROVIDER', 'resend');
		const t = convexTest(schema, modules);
		await seedRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'mandrill', isEnabled: true },
			],
		});

		expect(await read(t)).toMatchObject({
			kinds: ['mandrill', 'resend'],
			referenceTransportId: null,
		});
	});
});
