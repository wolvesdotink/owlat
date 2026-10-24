/**
 * The worker registry: per-service reports and their verdicts, the IMAP
 * server's reports landing here too, the code-worker's own entry point, the
 * status summary over every row (not just the capped list), the contract-step
 * waits, the MTA's signed report route, the platform-admin read and the prune.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signMtaRequest } from '@owlat/mta-protocol/signer';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';
import { readWorkerWaits, WORKER_LIVE_WINDOW_MS } from '../workerRegistry';

const caller = vi.hoisted(() => ({ subject: 'admin-user' }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => caller.subject),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockImplementation(async () => ({
			subject: caller.subject,
			issuer: 'test',
			tokenIdentifier: `test|${caller.subject}`,
		})),
	};
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = Date.UTC(2026, 9, 1, 12);
const SECRET = 'mta-test-secret';
const SAVED_ENV = { ...process.env };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	caller.subject = 'admin-user';
	delete process.env['MTA_API_URL'];
	delete process.env['MAIL_SYNC_API_URL'];
});

afterEach(() => {
	vi.useRealTimers();
	process.env = { ...SAVED_ENV };
});

const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

type Service = 'imap' | 'mail-sync' | 'mta' | 'code-worker';

function reportArgs(overrides: Partial<{ hostLabel: string; wireVersion: number }> = {}) {
	return {
		instanceId: 'proc-1',
		hostLabel: 'a1b2c3d4e5f6',
		owlatVersion: '0.6.17',
		wireVersion: 1,
		startedAt: T0 - 1000,
		...overrides,
	};
}

async function seedWorker(
	t: T,
	row: { service: Service; hostLabel: string; wireVersion: number; lastSeenAt: number }
) {
	await t.run((ctx) =>
		ctx.db.insert('workerServers', {
			instanceId: 'seed',
			owlatVersion: '0.6.17',
			startedAt: row.lastSeenAt,
			...row,
		})
	);
}

const rows = (t: T) => t.run((ctx) => ctx.db.query('workerServers').collect());

const statusOf = async (t: T, service: Service) => {
	const status = await t.query(internal.maintenance.workerRegistry.status, {});
	return status.services.find((entry) => entry.service === service)!;
};

describe('workerRegistry.report', () => {
	it('records each service separately and answers with that service contract', async () => {
		const t = harness();
		const answer = await t.mutation(internal.maintenance.workerRegistry.report, {
			service: 'mail-sync',
			...reportArgs(),
		});
		expect(answer).toEqual({ backendWireVersion: 1, minSupportedWireVersion: 0, compatible: true });
		await t.mutation(internal.maintenance.workerRegistry.report, {
			service: 'mta',
			...reportArgs(),
		});

		const recorded = await rows(t);
		expect(recorded.map((row) => row.service).sort()).toEqual(['mail-sync', 'mta']);
		expect(recorded[0]).toMatchObject({
			hostLabel: 'a1b2c3d4e5f6',
			wireVersion: 1,
			lastSeenAt: T0,
		});
	});

	it('updates one row per service, host and build across reports and restarts', async () => {
		const t = harness();
		const report = (args: ReturnType<typeof reportArgs>) =>
			t.mutation(internal.maintenance.workerRegistry.report, { service: 'mta', ...args });
		await report(reportArgs());
		vi.setSystemTime(T0 + 5 * MINUTE);
		await report({ ...reportArgs(), instanceId: 'proc-2', startedAt: T0 + 4 * MINUTE });

		let recorded = await rows(t);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ instanceId: 'proc-2', lastSeenAt: T0 + 5 * MINUTE });

		// A second replica is its own row.
		await report(reportArgs({ hostLabel: 'f6e5d4c3b2a1' }));
		recorded = await rows(t);
		expect(recorded).toHaveLength(2);
	});

	it('names an older and a newer worker by that service window', async () => {
		const t = harness();
		const answer = await t.mutation(internal.maintenance.workerRegistry.report, {
			service: 'mail-sync',
			...reportArgs({ wireVersion: 2 }),
		});
		expect(answer).toEqual({
			backendWireVersion: 1,
			minSupportedWireVersion: 0,
			compatible: false,
			reason: 'backend_older',
		});
		// The pre-reporting contract (0) is still served for the new services.
		expect(
			await t.mutation(internal.maintenance.workerRegistry.report, {
				service: 'mta',
				...reportArgs({ wireVersion: 0 }),
			})
		).toMatchObject({ compatible: true });
	});

	it('refuses a wire version that is not a non-negative integer', async () => {
		const t = harness();
		for (const wireVersion of [-1, 1.5, Number.NaN]) {
			await expect(
				t.mutation(internal.maintenance.workerRegistry.report, {
					service: 'mta',
					...reportArgs({ wireVersion }),
				})
			).rejects.toThrow(/wireVersion must be a non-negative integer/);
		}
		expect(await rows(t)).toHaveLength(0);
	});

	it("records the code-worker's report under its own service only", async () => {
		const t = harness();
		const answer = await t.mutation(
			internal.maintenance.workerRegistry.reportCodeWorker,
			reportArgs()
		);
		expect(answer).toMatchObject({ compatible: true });
		expect((await rows(t)).map((row) => row.service)).toEqual(['code-worker']);
	});

	it("records the IMAP server's report next to its own registry", async () => {
		const t = harness();
		await t.mutation(internal.mail.imap.serverRegistry.report, reportArgs({ wireVersion: 3 }));

		expect(await rows(t)).toEqual([
			expect.objectContaining({ service: 'imap', hostLabel: 'a1b2c3d4e5f6', wireVersion: 3 }),
		]);
		expect(await t.run((ctx) => ctx.db.query('imapServers').collect())).toHaveLength(1);
	});
});

describe('workerRegistry.status', () => {
	it('lists every service, reported or not, with verdicts and liveness', async () => {
		const t = harness();
		await seedWorker(t, { service: 'mta', hostLabel: 'm1', wireVersion: 1, lastSeenAt: T0 });
		await seedWorker(t, {
			service: 'mta',
			hostLabel: 'm2',
			wireVersion: 0,
			lastSeenAt: T0 - DAY,
		});
		// Outside the 7-day window.
		await seedWorker(t, {
			service: 'mta',
			hostLabel: 'm3',
			wireVersion: 0,
			lastSeenAt: T0 - 8 * DAY,
		});

		const status = await t.query(internal.maintenance.workerRegistry.status, {});
		expect(status.services.map((entry) => entry.service)).toEqual([
			'imap',
			'mail-sync',
			'mta',
			'code-worker',
		]);
		const mta = status.services[2]!;
		expect(mta.servers.map((server) => [server.hostLabel, server.verdict, server.isLive])).toEqual([
			['m1', 'current', true],
			['m2', 'supported', false],
		]);
		expect(mta).toMatchObject({
			backendWireVersion: 1,
			minSupportedWireVersion: 0,
			oldestWireVersionSeen: 0,
			newestWireVersionSeen: 1,
			isListTruncated: false,
			legacySeenAt: null,
		});
		expect(status.services[1]).toMatchObject({ servers: [], oldestWireVersionSeen: null });
	});

	it('summarizes over every row, past the capped list', async () => {
		const t = harness();
		// The oldest report sorts last by recency, beyond the 50 listed rows.
		await seedWorker(t, {
			service: 'mail-sync',
			hostLabel: 'old',
			wireVersion: 0,
			lastSeenAt: T0 - 2 * DAY,
		});
		for (let i = 0; i < 50; i++) {
			await seedWorker(t, {
				service: 'mail-sync',
				hostLabel: `h${i}`,
				wireVersion: 1,
				lastSeenAt: T0 - i * MINUTE,
			});
		}

		const mailSync = await statusOf(t, 'mail-sync');
		expect(mailSync.servers).toHaveLength(50);
		expect(mailSync.servers.some((server) => server.hostLabel === 'old')).toBe(false);
		expect(mailSync.isListTruncated).toBe(true);
		expect(mailSync.oldestWireVersionSeen).toBe(0);
	});

	it('counts a login through a pre-reporting IMAP server as wire 0', async () => {
		const t = harness();
		await t.run((ctx) =>
			ctx.db.insert('instanceCounters', {
				key: 'imapLegacy',
				legacyImapSeenAt: T0 - DAY,
				updatedAt: T0 - DAY,
			})
		);

		const imap = await statusOf(t, 'imap');
		expect(imap).toMatchObject({
			legacySeenAt: T0 - DAY,
			isLegacyInWindow: true,
			oldestWireVersionSeen: 0,
			newestWireVersionSeen: null,
		});
	});

	it('is refused to anyone but a platform admin', async () => {
		const t = harness();
		await expect(t.query(api.maintenance.workerRegistry.getForAdmin, {})).rejects.toThrow(
			/Platform admin access required/
		);

		await t.run((ctx) =>
			ctx.db.insert('platformAdmins', {
				authUserId: 'admin-user',
				email: 'admin@example.com',
				role: 'admin',
				createdAt: T0,
			})
		);
		const status = await t.query(api.maintenance.workerRegistry.getForAdmin, {});
		expect(status.windowDays).toBe(7);
	});
});

describe('readWorkerWaits', () => {
	const waits = (t: T, requirement: Partial<Record<Service, number>>) =>
		t.run((ctx) => readWorkerWaits(ctx.db, requirement, Date.now()));

	it('holds a step while a live worker reports a lower version', async () => {
		const t = harness();
		await seedWorker(t, { service: 'mta', hostLabel: 'm1', wireVersion: 2, lastSeenAt: T0 });
		await seedWorker(t, {
			service: 'mta',
			hostLabel: 'm2',
			wireVersion: 1,
			lastSeenAt: T0 - 2 * MINUTE,
		});

		expect(await waits(t, { mta: 2 })).toEqual([
			{ service: 'mta', requiredWireVersion: 2, reason: 'lagging', oldestLiveWireVersion: 1 },
		]);

		// The lagging replica stops reporting: once it is past the live window
		// the step may run.
		vi.setSystemTime(T0 - 2 * MINUTE + WORKER_LIVE_WINDOW_MS + 1);
		await seedWorker(t, {
			service: 'mta',
			hostLabel: 'm1',
			wireVersion: 2,
			lastSeenAt: Date.now(),
		});
		expect(await waits(t, { mta: 2 })).toEqual([]);
	});

	it('finds a lagging worker among more rows than any list shows', async () => {
		const t = harness();
		for (let i = 0; i < 60; i++) {
			await seedWorker(t, {
				service: 'mail-sync',
				hostLabel: `h${i}`,
				wireVersion: 3,
				lastSeenAt: T0 - (i % 5) * MINUTE,
			});
		}
		await seedWorker(t, {
			service: 'mail-sync',
			hostLabel: 'laggard',
			wireVersion: 2,
			lastSeenAt: T0 - 10 * MINUTE,
		});

		expect(await waits(t, { 'mail-sync': 3 })).toEqual([
			expect.objectContaining({
				service: 'mail-sync',
				reason: 'lagging',
				oldestLiveWireVersion: 2,
			}),
		]);
	});

	it('waits for evidence from a service that runs here but has not reported the version', async () => {
		const t = harness();
		// Configured, never reported.
		process.env['MTA_API_URL'] = 'http://mta.owlat.example:3100';
		// Reported this week, no longer live.
		await seedWorker(t, {
			service: 'code-worker',
			hostLabel: 'c1',
			wireVersion: 1,
			lastSeenAt: T0 - DAY,
		});

		expect(await waits(t, { mta: 1, 'code-worker': 1 })).toEqual([
			{ service: 'mta', requiredWireVersion: 1, reason: 'missing', oldestLiveWireVersion: null },
			{
				service: 'code-worker',
				requiredWireVersion: 1,
				reason: 'missing',
				oldestLiveWireVersion: null,
			},
		]);
	});

	it('does not hold a step on a service this deployment does not run', async () => {
		const t = harness();
		expect(await waits(t, { mta: 2, 'mail-sync': 2, imap: 4, 'code-worker': 2 })).toEqual([]);
	});
});

describe('POST /webhooks/mta-worker-report', () => {
	function post(
		t: T,
		body: string,
		headers: Record<string, string> = signMtaRequest(SECRET, body)
	) {
		return t.fetch('/webhooks/mta-worker-report', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body,
		});
	}

	beforeEach(() => {
		process.env['MTA_WEBHOOK_SECRET'] = SECRET;
	});

	it('records a signed report from each replica as an MTA', async () => {
		const t = harness();
		const first = await post(t, JSON.stringify(reportArgs()));
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			backendWireVersion: 1,
			minSupportedWireVersion: 0,
			compatible: true,
		});
		await post(t, JSON.stringify(reportArgs({ hostLabel: 'replica-2' })));

		const recorded = await rows(t);
		expect(recorded.map((row) => [row.service, row.hostLabel]).sort()).toEqual([
			['mta', 'a1b2c3d4e5f6'],
			['mta', 'replica-2'],
		]);
	});

	it('refuses an unsigned or wrongly signed report', async () => {
		const t = harness();
		const body = JSON.stringify(reportArgs());
		expect((await post(t, body, {})).status).toBe(401);
		expect((await post(t, body, signMtaRequest('another-secret', body))).status).toBe(401);
		expect(await rows(t)).toHaveLength(0);
	});

	it('refuses a malformed report after the signature check', async () => {
		const t = harness();
		for (const body of [
			'not json',
			JSON.stringify({ ...reportArgs(), wireVersion: '1' }),
			JSON.stringify({ ...reportArgs(), wireVersion: -1 }),
			JSON.stringify({ hostLabel: 'h' }),
		]) {
			expect((await post(t, body)).status).toBe(400);
		}
		expect(await rows(t)).toHaveLength(0);
	});

	it('refuses an oversized body', async () => {
		const t = harness();
		const body = JSON.stringify({ ...reportArgs(), hostLabel: 'x'.repeat(8 * 1024) });
		expect((await post(t, body)).status).toBe(413);
	});

	it('is closed while no MTA secret is configured', async () => {
		const t = harness();
		delete process.env['MTA_WEBHOOK_SECRET'];
		const body = JSON.stringify(reportArgs());
		expect((await post(t, body, signMtaRequest(SECRET, body))).status).toBe(503);
	});
});

describe('workerRegistry.pruneStale', () => {
	it('drops reports not refreshed for 30 days', async () => {
		const t = harness();
		await seedWorker(t, {
			service: 'mta',
			hostLabel: 'stale',
			wireVersion: 1,
			lastSeenAt: T0 - 31 * DAY,
		});
		await seedWorker(t, {
			service: 'mta',
			hostLabel: 'fresh',
			wireVersion: 1,
			lastSeenAt: T0 - 29 * DAY,
		});

		await t.mutation(internal.maintenance.workerRegistry.pruneStale, {});

		expect((await rows(t)).map((row) => row.hostLabel)).toEqual(['fresh']);
	});
});
