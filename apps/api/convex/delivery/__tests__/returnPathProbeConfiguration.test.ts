import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import schema from '../../schema';

/**
 * D2 REGRESSION PROOF — the probe must be silent on a deployment that has no
 * relay at all.
 *
 * The default `smtp` transport record always exists (default instances are
 * listed unconditionally), and the return-path configuration a plain
 * built-in-MTA install already has — a bounce domain, a VERP key, a default
 * From address — satisfies every OTHER gate, because setup projects the MTA's
 * own variables into the Convex ones. So without an explicit
 * "is this relay configured?" check the hourly sweep probes a relay that does
 * not exist, the send fails on the missing credentials, and the transport is
 * recorded `unsupported` / `rejected_by_relay` — a permanently misleading
 * operator-facing verdict about a relay nobody ever set up.
 *
 * Absence of a relay is a SUPPORTED CONFIGURATION (plan D2). Nothing is written
 * and nothing is surfaced.
 */

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

beforeEach(() => {
	// Everything the return-path configuration gate checks — and NO relay.
	vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'bounces.example.com');
	vi.stubEnv('MTA_BOUNCE_VERP_KEY', 'probe-config-key-'.padEnd(48, 'x'));
	vi.stubEnv('DEFAULT_FROM_EMAIL', 'news@example.com');
	vi.stubEnv('SMTP_RELAY_HOST', '');
	vi.stubEnv('SMTP_RELAY_USERNAME', '');
	vi.stubEnv('SMTP_RELAY_PASSWORD', '');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

async function probeRows(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => await ctx.db.query('sendTransportReturnPathProbes').collect());
}

describe('the return-path probe on a deployment with no relay', () => {
	it('runReturnPathProbe reports not_configured and writes nothing', async () => {
		const t = convexTest(schema, modules);
		const result = await t.action(internal.delivery.relayReturnPathProbe.runReturnPathProbe, {
			transportId: 'smtp',
		});
		expect(result).toEqual({ ran: false, reason: 'not_configured' });
		expect(await probeRows(t)).toHaveLength(0);
	});

	it('holds even when the caller FORCES the probe', async () => {
		// `force` skips the due-schedule check, not the configuration check: there
		// is no relay to ask, so there is nothing to force.
		const t = convexTest(schema, modules);
		const result = await t.action(internal.delivery.relayReturnPathProbe.runReturnPathProbe, {
			transportId: 'smtp',
			force: true,
		});
		expect(result).toEqual({ ran: false, reason: 'not_configured' });
		expect(await probeRows(t)).toHaveLength(0);
	});

	/**
	 * PROBE-DECIDED IS A CATALOG PROPERTY, NOT A KIND LIST (P1.3, plan D5).
	 *
	 * `isProbeableTransport` asks `isProbeDecidedReturnPathKind`, so a transport
	 * whose catalog entry declares `supportsCustomReturnPath: 'probe'` is in
	 * scope for the sweep the moment the entry lands — which is precisely what
	 * makes the SECOND gate load-bearing. The two skip reasons are the whole
	 * point of asserting this: `not_probeable` would mean the catalog declaration
	 * never reached the scheduler, while `not_configured` means it did and the D2
	 * configuration gate stopped it. Only the second is correct for a deployment
	 * that has no Mandrill account.
	 */
	it('treats mandrill as probe-decided and gates it on its OWN credentials', async () => {
		const t = convexTest(schema, modules);
		// No `MANDRILL_API_KEY` in this suite's environment.
		const result = await t.action(internal.delivery.relayReturnPathProbe.runReturnPathProbe, {
			transportId: 'mandrill',
			force: true,
		});
		expect(result).toEqual({ ran: false, reason: 'not_configured' });
		expect(result).not.toMatchObject({ reason: 'not_probeable' });
		expect(await probeRows(t)).toHaveLength(0);
	});

	it('still refuses an id this deployment cannot resolve at all', async () => {
		// The counterweight: `not_probeable`/`unresolvable_transport` are still
		// reachable, so the assertion above is about mandrill specifically rather
		// than about a gate that stopped rejecting anything.
		const t = convexTest(schema, modules);
		expect(
			await t.action(internal.delivery.relayReturnPathProbe.runReturnPathProbe, {
				transportId: 'mandrill#nope',
				force: true,
			})
		).toEqual({ ran: false, reason: 'unresolvable_transport' });
		// `ses` is a catalogued transport that DECLARES its answer, so probing it
		// would spend a real bounce to learn nothing.
		expect(
			await t.action(internal.delivery.relayReturnPathProbe.runReturnPathProbe, {
				transportId: 'ses',
				force: true,
			})
		).toEqual({ ran: false, reason: 'not_probeable' });
	});

	it('the hourly sweep probes nothing and records no verdict', async () => {
		const t = convexTest(schema, modules);
		const result = await t.action(internal.delivery.relayReturnPathProbe.sweepReturnPathProbes, {});
		expect(result).toEqual({ expired: 0, probed: 0 });
		const rows = await probeRows(t);
		expect(rows).toHaveLength(0);
		// Specifically: no `rejected_by_relay` verdict about a relay that does not
		// exist — the string an operator would otherwise be shown verbatim.
		expect(rows.map((row) => row.reason)).not.toContain('rejected_by_relay');
	});
});
