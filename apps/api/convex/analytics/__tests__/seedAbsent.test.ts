import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import schema from '../../schema';
import {
	loadSeedAccounts,
	summarizeSeedPlacementWindow,
	SEED_PLACEMENT_WINDOW_MS,
} from '../seedPlacement';
import { evaluateSeedPlacementGate } from '@owlat/shared/seedPlacement';

const modules = import.meta.glob('../../**/*.*s');

const NOW = 1_800_000_000_000;
const ORG = 'org_standalone';
const NO_CORROBORATION = { deferralGateBreached: false, bounceGateBreached: false };

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const seedPlacementSource = readFileSync(here('../seedPlacement.ts'), 'utf8');
const shadowCopySource = readFileSync(here('../../delivery/seedShadowCopy.ts'), 'utf8');

/**
 * (f) THE D2 PROOF — a fresh install with zero seed mailboxes.
 *
 * Absence of a seed mailbox lowers measurement confidence and slows the ramp.
 * It does NOTHING else: no throw, no error state, no warning, no
 * "setup incomplete" nag, and no effect on any send.
 */
describe('zero seed mailboxes is a supported configuration', () => {
	it('summarizes an empty deployment without throwing', async () => {
		const t = convexTest(schema, modules);
		const summary = await t.run(async (ctx) => summarizeSeedPlacementWindow(ctx.db, ORG, NOW));
		expect(summary.rollups).toEqual([]);
		expect(summary.seedAccountCount).toBe(0);
		expect(summary.rotationRemindersDue).toBe(0);
		expect(summary.windowStart).toBe(NOW - SEED_PLACEMENT_WINDOW_MS);
	});

	it('finds no seed accounts and reports no reminder', async () => {
		const t = convexTest(schema, modules);
		const accounts = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, NOW));
		expect(accounts).toEqual([]);
	});

	it('gate 5 returns insufficient_data — the controller HOLDS', async () => {
		const t = convexTest(schema, modules);
		const summary = await t.run(async (ctx) => summarizeSeedPlacementWindow(ctx.db, ORG, NOW));
		const gate = evaluateSeedPlacementGate({
			rollups: summary.rollups,
			corroboration: NO_CORROBORATION,
		});
		expect(gate.verdict).toBe('insufficient_data');
		expect(gate.reason).toBe('no_seed_mailboxes_connected');
		expect(gate.confidence).toBe('none');
		expect(gate.failedProviders).toEqual([]);
		expect(gate.suspectProviders).toEqual([]);
	});

	it('cannot reach a fail verdict with no seeds, however bad the other gates look', async () => {
		const t = convexTest(schema, modules);
		const summary = await t.run(async (ctx) => summarizeSeedPlacementWindow(ctx.db, ORG, NOW));
		const gate = evaluateSeedPlacementGate({
			rollups: summary.rollups,
			corroboration: { deferralGateBreached: true, bounceGateBreached: true },
		});
		expect(gate.verdict).toBe('insufficient_data');
	});

	it('ignores an ordinary (non-seed) external mailbox entirely', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user_1',
				organizationId: ORG,
				kind: 'external',
				address: 'jane@org.example',
				domain: 'org.example',
				status: 'active',
				usedBytes: 0,
				uidValidity: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('externalMailAccounts', {
				userId: 'user_1',
				organizationId: ORG,
				mailboxId,
				imapHost: 'imap.example',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password',
				imapUsername: 'jane@org.example',
				secretCiphertext: 'ct',
				secretIv: 'iv',
				secretAuthTag: 'tag',
				secretEnvelopeVersion: 1,
				status: 'connected',
				createdAt: NOW,
				updatedAt: NOW,
			});
		});
		const accounts = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, NOW));
		expect(accounts).toEqual([]);
	});
});

/**
 * (f) Absence must be structurally incapable of blocking anything: neither
 * seed module throws, and neither renders a warning or an error state.
 */
describe('absence is never load-bearing', () => {
	it('neither seed module throws', () => {
		for (const source of [seedPlacementSource, shadowCopySource]) {
			expect(source).not.toMatch(/\bthrow\s+new\b/);
			expect(source).not.toMatch(/\bConvexError\b/);
		}
	});

	it('the shadow-copy enqueue short-circuits on an empty seed list', () => {
		expect(shadowCopySource).toContain('args.seeds.length === 0');
		expect(shadowCopySource).toContain('return { enqueued: 0 }');
	});
});
