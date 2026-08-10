/**
 * FEEDBACK-CHANNEL HEALTH FOR A BUNDLED PLUGIN TRANSPORT
 * (`delivery.status.getProviderFeedbackStatus`).
 *
 * The core kinds are graded off `webhookPayloads`, the raw-retention table they
 * populate by default. A plugin transport does the inverse: retention is opt-in
 * per adapter (`storeRawPayload`, default off), so reading the same table for
 * them reported a perfectly working feedback channel as `awaiting_event`
 * FOREVER — never healthy, never stale, and therefore never able to tell an
 * operator that a transport's bounces stopped arriving.
 *
 * The replay-claim rows cannot stand in for it either: they expire inside the
 * signature contract's tolerance window (fifteen minutes at most) and are swept
 * both on the claim hot path and by a cron, while this grading works over a
 * SEVEN-DAY horizon. So the route stamps a durable per-transport marker when a
 * batch finishes dispatching, and that is what this suite drives:
 *
 *   never delivered            → awaiting_event
 *   a batch completes          → healthy
 *   nothing for over a week    → stale
 *   secret unset               → missing_configuration, whatever the marker says
 *
 * The whole plugin tier is generated, and this repo bundles none, so the three
 * generated artifacts are mocked exactly as the route suite mocks them — that is
 * the only way a plugin kind exists in the composed send catalog at all.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
	kind: 'plugin.mail-pack.postmark',
	pluginId: 'mail-pack',
	localId: 'postmark',
	secretEnv: 'PLUGIN_POSTMARK_WEBHOOK_SECRET',
}));

vi.mock('../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: fixture.kind,
			pluginId: fixture.pluginId,
			localId: fixture.localId,
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../plugins/sendTransportWebhookCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG: Object.freeze([
		Object.freeze({
			kind: fixture.kind,
			pluginId: fixture.pluginId,
			localId: fixture.localId,
			signature: Object.freeze({
				header: 'x-postmark-signature',
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				secretEnvVar: fixture.secretEnv,
				replay: Object.freeze({
					timestampHeader: 'x-postmark-timestamp',
					toleranceSeconds: 300,
				}),
			}),
			storeRawPayload: false,
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../plugins/sendTransportWebhookModules.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES: Object.freeze([
		Object.freeze({
			kind: fixture.kind,
			pluginId: fixture.pluginId,
			module: { parseEvents: () => [] },
		}),
	]),
}));

// Admin floor: this query is `adminQuery` (organization:manage). The gate has its
// own coverage in `status.test.ts`; here it is satisfied so the READ is testable.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
	};
});

import { api, internal } from '../../_generated/api';
import schema from '../../schema';
import { PROVIDER_FEEDBACK_STALE_AFTER_MS } from '../../providers/feedbackStatus';

// Vite's `import.meta.glob` omits the directory chain it climbed to reach the
// base, so the sibling `delivery/*` modules need a second glob re-prefixed to the
// same `../../`-relative form — see the note in `status.test.ts`.
const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
			path.replace(/^\.\.\//, '../../delivery/'),
			mod,
		])
	),
};

const KIND = fixture.kind;
const PLUGIN_ID = fixture.pluginId;

async function feedbackStatus(t: ReturnType<typeof convexTest>) {
	return t.query(api.delivery.status.getProviderFeedbackStatus, { transportId: KIND });
}

beforeEach(() => {
	vi.stubEnv(fixture.secretEnv, 'a-shared-signing-secret');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('a bundled plugin feedback channel', () => {
	it('is awaiting_event before anything has ever landed', async () => {
		const t = convexTest(schema, modules);
		expect(await feedbackStatus(t)).toEqual({
			status: 'awaiting_event',
			lastEventAt: null,
			missingVariables: [],
			ceremony: 'none',
		});
	});

	it('becomes healthy when a delivery completes — with retention OFF', async () => {
		// The regression this whole change exists for. This adapter does not opt into
		// raw retention, so `webhookPayloads` stays empty no matter how much feedback
		// arrives; before the durable marker the channel could therefore never leave
		// `awaiting_event`, and an operator had no way to see the difference between
		// a transport that had never delivered and one delivering all day.
		const t = convexTest(schema, modules);
		await t.mutation(internal.webhooks.pluginFeedbackDeliveries.claim, {
			pluginId: PLUGIN_ID,
			transportKind: KIND,
			deliveryDigest: 'digest-1',
			expiresAt: Date.now() + 600_000,
		});
		await t.mutation(internal.webhooks.pluginFeedbackDeliveries.complete, {
			pluginId: PLUGIN_ID,
			transportKind: KIND,
			deliveryDigest: 'digest-1',
		});

		const payloads = await t.run(async (ctx) => ctx.db.query('webhookPayloads').collect());
		expect(payloads).toEqual([]);

		const status = await feedbackStatus(t);
		expect(status?.status).toBe('healthy');
		expect(status?.lastEventAt).toBeLessThanOrEqual(Date.now());
	});

	it('goes stale when the last completed batch falls outside the horizon', async () => {
		const t = convexTest(schema, modules);
		const lastEventAt = Date.now() - PROVIDER_FEEDBACK_STALE_AFTER_MS - 60_000;
		await t.run(async (ctx) => {
			await ctx.db.insert('pluginWebhookFeedbackActivity', {
				pluginId: PLUGIN_ID,
				transportKind: KIND,
				lastEventAt,
			});
		});

		expect(await feedbackStatus(t)).toEqual({
			status: 'stale',
			lastEventAt,
			missingVariables: [],
			ceremony: 'none',
		});
	});

	it('reads the marker for THIS transport only', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('pluginWebhookFeedbackActivity', {
				pluginId: 'other-pack',
				transportKind: 'plugin.other-pack.sendgrid',
				lastEventAt: Date.now(),
			});
		});
		expect((await feedbackStatus(t))?.status).toBe('awaiting_event');
	});

	it('does NOT survive on a replay claim, which expires within the tolerance window', async () => {
		// A claim row is not evidence of a healthy channel: it is gone in fifteen
		// minutes while this grading works over seven days, so reading one here would
		// make every channel flip to `awaiting_event` between deliveries.
		const t = convexTest(schema, modules);
		await t.mutation(internal.webhooks.pluginFeedbackDeliveries.claim, {
			pluginId: PLUGIN_ID,
			transportKind: KIND,
			deliveryDigest: 'in-flight',
			expiresAt: Date.now() + 600_000,
		});

		expect((await feedbackStatus(t))?.status).toBe('awaiting_event');
	});

	it('still reports missing configuration when the signing secret is unset', async () => {
		// Configuration outranks liveness: a channel whose secret is gone cannot
		// verify anything, whatever it last delivered.
		vi.stubEnv(fixture.secretEnv, '');
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('pluginWebhookFeedbackActivity', {
				pluginId: PLUGIN_ID,
				transportKind: KIND,
				lastEventAt: Date.now(),
			});
		});

		const status = await feedbackStatus(t);
		expect(status?.status).toBe('missing_configuration');
		expect(status?.missingVariables).toEqual([fixture.secretEnv]);
	});

	it('never returns the signing secret', async () => {
		const SECRET = 'plugin-feedback-secret-DO-NOT-LEAK';
		vi.stubEnv(fixture.secretEnv, SECRET);
		const t = convexTest(schema, modules);
		expect(JSON.stringify(await feedbackStatus(t))).not.toContain(SECRET);
	});
});
