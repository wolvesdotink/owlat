/**
 * `adaptive_mix` — calibration slice sizing by phase (plan D8), and the
 * `isCalibration` flag reaching the assignment row.
 *
 * The slice is the ONLY input to the engagement-ratio gate, so its size is a
 * budget decision the controller depends on: too small and the gate never has
 * its minimum sample (D10), too large and warming quality is sacrificed for
 * measurement it does not need once the share is high.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../../../schema';
// The delivery suite's module map, reused rather than copied: its two-glob
// preamble already covers the whole `convex/` tree from a `__tests__` folder,
// and a fifth copy of that preamble is exactly what it was extracted to avoid.
import { modules } from '../../../../delivery/__tests__/testModules';
import { sendProviderCatalogEntry } from '../../catalog';
import type { SendProviderKind } from '../../types';
import {
	calibrationSliceFor,
	CALIBRATION_SLICE_AT_OR_ABOVE_HALF,
	CALIBRATION_SLICE_BELOW_HALF,
} from '../adaptive_mix';
import { recordSendAssignments } from '../../../../delivery/sendAssignments';
import { assignAll, calibrationShare, syntheticContactIds } from './fixtures';

const AUDIENCE = syntheticContactIds(20_000, 'cal');
const ORG = 'org-calibration';

describe('adaptive_mix — calibration slice sizing', () => {
	it('is 10% below s=0.5 and 5% at or above it', () => {
		expect(calibrationSliceFor(0.02)).toBe(CALIBRATION_SLICE_BELOW_HALF);
		expect(calibrationSliceFor(0.49)).toBe(CALIBRATION_SLICE_BELOW_HALF);
		expect(calibrationSliceFor(0.5)).toBe(CALIBRATION_SLICE_AT_OR_ABOVE_HALF);
		expect(calibrationSliceFor(0.8)).toBe(CALIBRATION_SLICE_AT_OR_ABOVE_HALF);
	});

	it('is 0% after graduation', () => {
		expect(calibrationSliceFor(0.3, true)).toBe(0);
		expect(calibrationSliceFor(0.9, true)).toBe(0);
	});

	it('is 0% for a degenerate cell — both arms of the split are one arm', () => {
		expect(calibrationSliceFor(0)).toBe(0);
		expect(calibrationSliceFor(1)).toBe(0);
	});

	it.each([
		[0.05, CALIBRATION_SLICE_BELOW_HALF],
		[0.3, CALIBRATION_SLICE_BELOW_HALF],
		[0.5, CALIBRATION_SLICE_AT_OR_ABOVE_HALF],
		[0.85, CALIBRATION_SLICE_AT_OR_ABOVE_HALF],
	])('realises the configured slice size at s=%s', (ownShare, expected) => {
		const assignments = assignAll(AUDIENCE, { ownShare, mixVersion: 2 }, { campaignId: 'cmp-c' });
		expect(Math.abs(calibrationShare(assignments) - expected)).toBeLessThan(0.01);
	});

	it('marks nothing as calibration once the cell has graduated', () => {
		const assignments = assignAll(
			AUDIENCE,
			{ ownShare: 0.9, mixVersion: 2, isGraduated: true },
			{ campaignId: 'cmp-c' }
		);
		expect(calibrationShare(assignments)).toBe(0);
	});
});

describe('adaptive_mix — assignment rows carry the calibration flag', () => {
	// Stub EVERY env var the catalog says a transport needs, read FROM the
	// catalog: a fixture that misses one silently removes the relay from the
	// route, and every "this cell resolved to the reference arm" assertion goes
	// vacuously green instead of red.
	function stubTransportEnv(kind: SendProviderKind): void {
		for (const name of sendProviderCatalogEntry(kind).requiredEnvVars) {
			vi.stubEnv(name, name === 'MTA_API_URL' ? 'https://mta.test' : `test-${name.toLowerCase()}`);
		}
	}

	beforeEach(() => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		stubTransportEnv('mta');
		stubTransportEnv('ses');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	async function seedAdaptiveRoute(t: ReturnType<typeof convexTest>, ownShare: number) {
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'adaptive_mix',
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'ses', isEnabled: true },
				],
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail',
				stream: 'campaign',
				isFallbackActive: false,
				ownShare,
				mixVersion: 5,
				signals: [],
				snapshotGeneratedAt: now,
				expiresAt: now + 600_000,
				updatedAt: now,
			});
		});
	}

	it('writes isCalibration and mixVersion from the mix decision', async () => {
		const t = convexTest(schema, modules);
		await seedAdaptiveRoute(t, 0.4);
		const contactIds = syntheticContactIds(600, 'row');
		await t.run(async (ctx) => {
			await recordSendAssignments(ctx, {
				organizationId: ORG,
				stream: 'campaign',
				sendKind: 'campaign',
				campaignId: 'cmp-rows',
				routing: { messageType: 'campaign', from: 'news@example.com' },
				recipients: contactIds.map((contactId, index) => ({
					sendId: `send-${index}`,
					email: `user${index}@gmail.com`,
					contactId,
				})),
			});
		});
		const rows = await t.run(async (ctx) => await ctx.db.query('sendAssignments').collect());
		expect(rows.length).toBe(600);
		// Every row carries the controller's version, not the router-only 0.
		expect(rows.every((row) => row.mixVersion === 5)).toBe(true);
		const calibration = rows.filter((row) => row.isCalibration);
		// s = 0.4 ⇒ a 10% slice.
		expect(calibration.length).toBeGreaterThan(30);
		expect(calibration.length).toBeLessThan(110);
		// Both arms are present, and the split tracks the share.
		const own = rows.filter((row) => row.arm === 'own').length;
		expect(Math.abs(own / rows.length - 0.4)).toBeLessThan(0.08);
		expect(rows.every((row) => (row.arm === 'own') === (row.transport === 'mta'))).toBe(true);
	});

	it('records no calibration rows under a shipped (non-splitting) strategy', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: true }],
				createdAt: now,
				updatedAt: now,
			});
		});
		await t.run(async (ctx) => {
			await recordSendAssignments(ctx, {
				organizationId: ORG,
				stream: 'campaign',
				sendKind: 'campaign',
				campaignId: 'cmp-single',
				routing: { messageType: 'campaign', from: 'news@example.com' },
				recipients: [{ sendId: 's1', email: 'a@gmail.com', contactId: 'c1' }],
			});
		});
		const rows = await t.run(async (ctx) => await ctx.db.query('sendAssignments').collect());
		expect(rows.length).toBe(1);
		expect(rows[0]?.isCalibration).toBe(false);
		expect(rows[0]?.mixVersion).toBe(0);
	});
});
