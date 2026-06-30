import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestContact, createTestKnowledgeEntry } from './factories';
import type { Id } from '../_generated/dataModel';
import { accessBoostFactor } from '../knowledge/maintenance';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('agentClassifier') &&
		!path.includes('agentDrafter') &&
		!path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') &&
		!path.includes('knowledgeExtraction') &&
		!path.includes('semanticFileProcessing') &&
		!path.includes('visualizationAgent') &&
		!path.includes('llmProvider')
	)
);

// ============ knowledgeMaintenance.runDecay ============

describe('knowledgeMaintenance.runDecay', () => {
	it('should not decay event entries (decay rate = 0)', async () => {
		const t = convexTest(schema, modules);
		const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

		let eventId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			eventId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'event',
				title: 'Historical Event',
				content: 'This event should not decay.',
				sourceType: 'manual',
				confidence: 0.9,
				lastValidatedAt: twoDaysAgo,
			}));
		});

		const result = await t.mutation(internal.knowledge.maintenance.runDecay, {});
		expect(result.decayed).toBe(0);

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(eventId);
			expect(entry!.confidence).toBe(0.9); // unchanged
		});
	});

	it('should decay facts at the correct rate (0.5% per day)', async () => {
		const t = convexTest(schema, modules);
		const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
		const originalConfidence = 0.8;

		let factId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			factId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Decaying Fact',
				content: 'This fact should decay slowly.',
				sourceType: 'manual',
				confidence: originalConfidence,
				lastValidatedAt: tenDaysAgo,
			}));
		});

		const result = await t.mutation(internal.knowledge.maintenance.runDecay, {});
		expect(result.decayed).toBe(1);

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(factId);
			// Expected: 0.8 * (1 - 0.005)^10 ≈ 0.8 * 0.9511 ≈ 0.7609
			const expectedConfidence = originalConfidence * Math.pow(1 - 0.005, 10);
			expect(entry!.confidence).toBeCloseTo(expectedConfidence, 3);
			expect(entry!.confidence).toBeLessThan(originalConfidence);
		});
	});

	it('should decay action items faster than facts (5% per day)', async () => {
		const t = convexTest(schema, modules);
		const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
		const originalConfidence = 0.8;

		let actionId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			actionId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'action_item',
				title: 'Urgent Action',
				content: 'This should decay fast.',
				sourceType: 'manual',
				confidence: originalConfidence,
				lastValidatedAt: fiveDaysAgo,
			}));
		});

		await t.mutation(internal.knowledge.maintenance.runDecay, {});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(actionId);
			// Expected: 0.8 * (1 - 0.05)^5 ≈ 0.8 * 0.7738 ≈ 0.6190
			const expectedConfidence = originalConfidence * Math.pow(1 - 0.05, 5);
			expect(entry!.confidence).toBeCloseTo(expectedConfidence, 3);
			expect(entry!.confidence).toBeLessThan(originalConfidence);
		});
	});

	it('should enforce minimum confidence floor of 0.1', async () => {
		const t = convexTest(schema, modules);
		// Use a very old validation time so decay drives confidence far below floor
		const hundredDaysAgo = Date.now() - 100 * 24 * 60 * 60 * 1000;

		let actionId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			actionId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'action_item', // 5% per day decay rate
				title: 'Ancient Action',
				content: 'Should hit confidence floor.',
				sourceType: 'manual',
				confidence: 0.5,
				lastValidatedAt: hundredDaysAgo,
			}));
		});

		await t.mutation(internal.knowledge.maintenance.runDecay, {});

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(actionId);
			// After 100 days at 5%/day: 0.5 * (0.95)^100 ≈ 0.003 → clamped to 0.1
			expect(entry!.confidence).toBe(0.1);
		});
	});

	it('should not decay entries validated today', async () => {
		const t = convexTest(schema, modules);

		let factId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			factId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Recently Validated',
				content: 'Should not be decayed.',
				sourceType: 'manual',
				confidence: 0.8,
				lastValidatedAt: Date.now(), // validated now
			}));
		});

		const result = await t.mutation(internal.knowledge.maintenance.runDecay, {});
		expect(result.decayed).toBe(0);

		await t.run(async (ctx) => {
			const entry = await ctx.db.get(factId);
			expect(entry!.confidence).toBe(0.8);
		});
	});

	it('should handle expired entry cleanup during decay run', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		let expiredId!: Id<'knowledgeEntries'>;
		let validId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			expiredId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Expired Entry',
				content: 'should be deleted',
				sourceType: 'manual',
				expiresAt: now - 1000,
			}));
			validId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Valid Entry',
				content: 'should remain',
				sourceType: 'manual',
				confidence: 0.8,
				lastValidatedAt: now, // recent, so no decay
			}));
		});

		const result = await t.mutation(internal.knowledge.maintenance.runDecay, {});
		expect(result.expired).toBe(1);

		await t.run(async (ctx) => {
			const expired = await ctx.db.get(expiredId);
			expect(expired).toBeNull();
			const valid = await ctx.db.get(validId);
			expect(valid).toBeDefined();
		});
	});

	it('should delete contact junction rows of expired entries during decay', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		let contactId!: Id<'contacts'>;
		let expiredId!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			expiredId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Expired With Contact',
				content: 'expired',
				sourceType: 'manual',
				contactIds: [contactId],
				expiresAt: now - 1000,
			}));
			await ctx.db.insert('knowledgeEntryContacts', { entryId: expiredId, contactId });
		});

		await t.mutation(internal.knowledge.maintenance.runDecay, {});

		await t.run(async (ctx) => {
			expect(await ctx.db.get(expiredId)).toBeNull();
			const links = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_entry', (q) => q.eq('entryId', expiredId))
				.collect();
			expect(links).toHaveLength(0);
		});
	});

	it('should delete relations of expired entries during decay', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		let expiredId!: Id<'knowledgeEntries'>;
		let otherId!: Id<'knowledgeEntries'>;
		let relationId!: Id<'knowledgeRelations'>;

		await t.run(async (ctx) => {
			expiredId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'goal',
				title: 'Expired Goal',
				content: 'expired',
				sourceType: 'manual',
				expiresAt: now - 5000,
			}));
			otherId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Linked Fact',
				content: 'linked',
				sourceType: 'manual',
				lastValidatedAt: now,
			}));
			relationId = await ctx.db.insert('knowledgeRelations', {
				fromEntryId: expiredId,
				toEntryId: otherId,
				relationType: 'causes',
				confidenceTag: 'extracted',
				confidence: 1.0,
				provenance: 'manual',
				createdAt: now,
				updatedAt: now,
			});
		});

		await t.mutation(internal.knowledge.maintenance.runDecay, {});

		await t.run(async (ctx) => {
			const relation = await ctx.db.get(relationId);
			expect(relation).toBeNull();
			const other = await ctx.db.get(otherId);
			expect(other).toBeDefined();
		});
	});

	it('should return correct processed count', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
					entryType: 'event',
					title: `Event ${i}`,
					content: `event ${i}`,
					sourceType: 'manual',
					lastValidatedAt: now,
				}));
			}
		});

		const result = await t.mutation(internal.knowledge.maintenance.runDecay, {});
		expect(result.processed).toBe(3);
		expect(result.decayed).toBe(0); // events don't decay
		expect(result.expired).toBe(0);
	});

	it('should decay multiple entry types correctly in one run', async () => {
		const t = convexTest(schema, modules);
		const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

		let factId!: Id<'knowledgeEntries'>;
		let preferenceId!: Id<'knowledgeEntries'>;
		let eventId!: Id<'knowledgeEntries'>;

		await t.run(async (ctx) => {
			factId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Mixed Fact',
				content: 'fact',
				sourceType: 'manual',
				confidence: 1.0,
				lastValidatedAt: threeDaysAgo,
			}));
			preferenceId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'preference',
				title: 'Mixed Preference',
				content: 'pref',
				sourceType: 'manual',
				confidence: 1.0,
				lastValidatedAt: threeDaysAgo,
			}));
			eventId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'event',
				title: 'Mixed Event',
				content: 'event',
				sourceType: 'manual',
				confidence: 1.0,
				lastValidatedAt: threeDaysAgo,
			}));
		});

		const result = await t.mutation(internal.knowledge.maintenance.runDecay, {});
		expect(result.decayed).toBe(2); // fact and preference decayed, event skipped

		await t.run(async (ctx) => {
			const fact = await ctx.db.get(factId);
			const pref = await ctx.db.get(preferenceId);
			const event = await ctx.db.get(eventId);

			// Fact: (1-0.005)^3 ≈ 0.9851
			expect(fact!.confidence).toBeCloseTo(Math.pow(1 - 0.005, 3), 3);
			// Preference: (1-0.015)^3 ≈ 0.9556
			expect(pref!.confidence).toBeCloseTo(Math.pow(1 - 0.015, 3), 3);
			// Event: unchanged
			expect(event!.confidence).toBe(1.0);
		});
	});
});

// ============ usage-recency boost ============

const DAY = 24 * 60 * 60 * 1000;

describe('accessBoostFactor', () => {
	const now = 1_000 * DAY;
	it('boosts (slows decay for) recently-recalled entries', () => {
		expect(accessBoostFactor(now, now)).toBe(1.1);
		expect(accessBoostFactor(now - 6 * DAY, now)).toBe(1.1);
	});
	it('penalizes (speeds decay for) entries gone cold (>30d)', () => {
		expect(accessBoostFactor(now - 31 * DAY, now)).toBe(0.9);
	});
	it('leaves mid-range and never-recalled entries unchanged', () => {
		expect(accessBoostFactor(now - 14 * DAY, now)).toBe(1.0);
		expect(accessBoostFactor(undefined, now)).toBe(1.0);
	});
});

describe('runDecay — usage-recency boost', () => {
	it('decays a recently-accessed entry less than one gone cold', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		let hot!: Id<'knowledgeEntries'>;
		let cold!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			hot = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'goal', // 3%/day, old enough to decay
				title: 'Hot goal',
				content: 'recently grounded',
				sourceType: 'manual',
				confidence: 0.9,
				lastValidatedAt: now - 10 * DAY,
				lastAccessedAt: now, // recalled just now
			}));
			cold = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'goal',
				title: 'Cold goal',
				content: 'long unused',
				sourceType: 'manual',
				confidence: 0.9,
				lastValidatedAt: now - 10 * DAY,
				lastAccessedAt: now - 60 * DAY, // last touched two months ago
			}));
		});

		await t.mutation(internal.knowledge.maintenance.runDecay, {});

		await t.run(async (ctx) => {
			const h = await ctx.db.get(hot);
			const c = await ctx.db.get(cold);
			expect(h!.confidence).toBeGreaterThan(c!.confidence);
			expect(h!.confidence).toBeLessThan(0.9); // still decayed, just slower
		});
	});
});

const DIM = 1536;
function unit(at: number): number[] {
	const vec = Array.from({ length: DIM }, () => 0);
	vec[at] = 1;
	return vec;
}

async function insertContactEntry(
	t: ReturnType<typeof convexTest>,
	contactId: Id<'contacts'>,
	opts: { title: string; content: string; embedAt: number; confidence: number },
): Promise<Id<'knowledgeEntries'>> {
	return await t.run(async (ctx) => {
		const entryId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
			entryType: 'fact',
			title: opts.title,
			content: opts.content,
			sourceType: 'email',
			confidence: opts.confidence,
			contactIds: [contactId],
			embedding: unit(opts.embedAt),
		}));
		await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId });
		return entryId;
	});
}

describe('dedupeContactEntries', () => {
	it('merges near-duplicate entries into a deterministic survivor and converges', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		// Two near-identical facts (same embedding) + one distinct fact.
		const survivor = await insertContactEntry(t, contactId, {
			title: 'Berlin A', content: 'lives in Berlin', embedAt: 5, confidence: 0.9,
		});
		const loser = await insertContactEntry(t, contactId, {
			title: 'Berlin B', content: 'Berlin-based', embedAt: 5, confidence: 0.6,
		});
		const distinct = await insertContactEntry(t, contactId, {
			title: 'Role', content: 'is the CTO', embedAt: 900, confidence: 0.8,
		});

		const r1 = await t.mutation(internal.knowledge.maintenance.dedupeContactEntries, { contactId });
		expect(r1.merged).toBe(1);

		await t.run(async (ctx) => {
			// Higher-confidence entry survived; lower-confidence duplicate deleted.
			const s = await ctx.db.get(survivor);
			const l = await ctx.db.get(loser);
			const d = await ctx.db.get(distinct);
			expect(s).not.toBeNull();
			expect(l).toBeNull();
			expect(d).not.toBeNull();
			// Survivor folded in the loser's distinct content.
			expect(s!.content).toContain('lives in Berlin');
			expect(s!.content).toContain('Berlin-based');

			// Junction: one row each for survivor + distinct, none dangling on loser.
			const links = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			expect(links).toHaveLength(2);
			expect(links.some((x) => x.entryId === loser)).toBe(false);
		});

		// Idempotent: a second pass finds nothing more to merge.
		const r2 = await t.mutation(internal.knowledge.maintenance.dedupeContactEntries, { contactId });
		expect(r2.merged).toBe(0);
	});

	it('accumulates content + tags + searchableText across a 3+-entry cluster', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		// Three same-embedding facts with distinct content + tags — they all cluster.
		const survivor = await t.run(async (ctx) => {
			const entryId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact', title: 'A', content: 'fact alpha', sourceType: 'email',
				confidence: 0.9, contactIds: [contactId], tags: ['t-alpha'], embedding: unit(5),
				searchableText: 'A fact alpha',
			}));
			await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId });
			return entryId;
		});
		await t.run(async (ctx) => {
			const e1 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact', title: 'B', content: 'fact beta', sourceType: 'email',
				confidence: 0.6, contactIds: [contactId], tags: ['t-beta'], embedding: unit(5),
				searchableText: 'B fact beta',
			}));
			await ctx.db.insert('knowledgeEntryContacts', { entryId: e1, contactId });
			const e2 = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact', title: 'C', content: 'fact gamma', sourceType: 'email',
				confidence: 0.5, contactIds: [contactId], tags: ['t-gamma'], embedding: unit(5),
				searchableText: 'C fact gamma',
			}));
			await ctx.db.insert('knowledgeEntryContacts', { entryId: e2, contactId });
		});

		const r = await t.mutation(internal.knowledge.maintenance.dedupeContactEntries, { contactId });
		expect(r.merged).toBe(2);

		await t.run(async (ctx) => {
			const s = await ctx.db.get(survivor);
			expect(s).not.toBeNull();
			// All three phrasings + all tags survive, not just the last loser's.
			for (const phrase of ['fact alpha', 'fact beta', 'fact gamma']) {
				expect(s!.content).toContain(phrase);
				// searchableText (the FTS index field) is recomputed from merged content.
				expect(s!.searchableText).toContain(phrase);
			}
			expect(new Set(s!.tags)).toEqual(new Set(['t-alpha', 't-beta', 't-gamma']));
		});
	});

	it('no-ops a contact with fewer than two comparable entries', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});
		await insertContactEntry(t, contactId, {
			title: 'only', content: 'one fact', embedAt: 1, confidence: 0.9,
		});
		const r = await t.mutation(internal.knowledge.maintenance.dedupeContactEntries, { contactId });
		expect(r.merged).toBe(0);
	});

	it('collapses a parallel (from,to,type) edge into one merged row and drops self-loops on merge', async () => {
		const t = convexTest(schema, modules);
		const oldTs = Date.now() - 100_000;
		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		// survivor + loser cluster (same embedding); nodeX is distinct and stays.
		const survivor = await insertContactEntry(t, contactId, {
			title: 'Berlin A', content: 'lives in Berlin', embedAt: 5, confidence: 0.9,
		});
		const loser = await insertContactEntry(t, contactId, {
			title: 'Berlin B', content: 'Berlin-based', embedAt: 5, confidence: 0.6,
		});
		const nodeX = await insertContactEntry(t, contactId, {
			title: 'Role', content: 'is the CTO', embedAt: 900, confidence: 0.8,
		});

		await t.run(async (ctx) => {
			// Survivor already links to nodeX — weak, LLM-ambiguous, with a rationale.
			await ctx.db.insert('knowledgeRelations', {
				fromEntryId: survivor, toEntryId: nodeX, relationType: 'relates_to',
				confidence: 0.4, confidenceTag: 'ambiguous', provenance: 'llm', weight: 0.4,
				rationale: 'survivor-kept', createdAt: oldTs, updatedAt: oldTs,
			});
			// Loser links to nodeX with the SAME (to,type) but stronger evidence — this
			// is the parallel edge a blind re-point would duplicate.
			await ctx.db.insert('knowledgeRelations', {
				fromEntryId: loser, toEntryId: nodeX, relationType: 'relates_to',
				confidence: 0.95, confidenceTag: 'extracted', provenance: 'manual', weight: 0.95,
				rationale: 'loser-dropped', createdAt: oldTs, updatedAt: oldTs,
			});
			// Loser → survivor becomes a self-loop once repointed; it must be dropped.
			await ctx.db.insert('knowledgeRelations', {
				fromEntryId: loser, toEntryId: survivor, relationType: 'relates_to',
				confidence: 1.0, confidenceTag: 'extracted', provenance: 'manual',
				createdAt: oldTs, updatedAt: oldTs,
			});
		});

		const r = await t.mutation(internal.knowledge.maintenance.dedupeContactEntries, { contactId });
		expect(r.merged).toBe(1);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(loser)).toBeNull();
			const edges = await ctx.db.query('knowledgeRelations').collect();
			// Parallel edge collapsed + self-loop dropped → exactly one edge remains.
			expect(edges).toHaveLength(1);
			const edge = edges[0]!;
			expect(edge.fromEntryId).toBe(survivor);
			expect(edge.toEntryId).toBe(nodeX);
			expect(edge.relationType).toBe('relates_to');
			// Strongest evidence from either side; kept edge's rationale preserved.
			expect(edge.confidence).toBe(0.95);
			expect(edge.confidenceTag).toBe('extracted');
			expect(edge.provenance).toBe('manual');
			expect(edge.weight).toBe(0.95);
			expect(edge.rationale).toBe('survivor-kept');
			expect(edge.updatedAt).toBeGreaterThan(oldTs);
		});
	});
});

describe('runKnowledgeDedup (cron driver)', () => {
	it('schedules a per-contact dedup for each contact in a single page', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({ email: 'a@example.com' }));
			await ctx.db.insert('contacts', createTestContact({ email: 'b@example.com' }));
		});

		const r = await t.mutation(internal.knowledge.maintenance.runKnowledgeDedup, {});
		expect(r.scheduled).toBe(2);
		expect(r.done).toBe(true);

		const dedupJobs = await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query('_scheduled_functions').collect();
			return jobs.filter((j) => (j.name ?? '').includes('dedupeContactEntries')).length;
		});
		expect(dedupJobs).toBe(2);
	});
});

describe('knowledge.graph.recordAccess', () => {
	it('bumps accessCount and stamps lastAccessedAt; tolerates deleted ids', async () => {
		const t = convexTest(schema, modules);
		let id!: Id<'knowledgeEntries'>;
		await t.run(async (ctx) => {
			id = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				entryType: 'fact',
				title: 'Tracked',
				content: 'usage tracked',
				sourceType: 'manual',
			}));
		});

		await t.mutation(internal.knowledge.graph.recordAccess, { ids: [id] });
		await t.mutation(internal.knowledge.graph.recordAccess, { ids: [id] });

		await t.run(async (ctx) => {
			const e = await ctx.db.get(id);
			expect(e!.accessCount).toBe(2);
			expect(e!.lastAccessedAt).toBeGreaterThan(0);
		});

		await t.run(async (ctx) => ctx.db.delete(id));
		// Must not throw on a since-deleted id.
		await t.mutation(internal.knowledge.graph.recordAccess, { ids: [id] });
	});
});

// ============ relationDecay.reapAmbiguousEdges ============

describe('reapAmbiguousEdges', () => {
	it('reaps only stale ambiguous LLM edges; keeps recent/inferred/extracted/manual', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const old = now - 31 * DAY; // past the 30d ambiguous-edge TTL
		let a!: Id<'knowledgeEntries'>;
		let b!: Id<'knowledgeEntries'>;
		let staleAmbiguousLlm!: Id<'knowledgeRelations'>;
		let recentAmbiguousLlm!: Id<'knowledgeRelations'>;
		let staleInferredLlm!: Id<'knowledgeRelations'>;
		let staleExtractedManual!: Id<'knowledgeRelations'>;
		let staleAmbiguousManual!: Id<'knowledgeRelations'>;

		await t.run(async (ctx) => {
			a = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ sourceType: 'manual' }));
			b = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({ sourceType: 'manual' }));
			// Distinct relationTypes so all five coexist on the same (a,b) pair.
			staleAmbiguousLlm = await ctx.db.insert('knowledgeRelations', {
				fromEntryId: a, toEntryId: b, relationType: 'relates_to',
				confidence: 0.4, confidenceTag: 'ambiguous', provenance: 'llm',
				createdAt: old, updatedAt: old,
			});
			recentAmbiguousLlm = await ctx.db.insert('knowledgeRelations', {
				fromEntryId: a, toEntryId: b, relationType: 'supports',
				confidence: 0.4, confidenceTag: 'ambiguous', provenance: 'llm',
				createdAt: now, updatedAt: now,
			});
			staleInferredLlm = await ctx.db.insert('knowledgeRelations', {
				fromEntryId: a, toEntryId: b, relationType: 'causes',
				confidence: 0.8, confidenceTag: 'inferred', provenance: 'llm',
				createdAt: old, updatedAt: old,
			});
			staleExtractedManual = await ctx.db.insert('knowledgeRelations', {
				fromEntryId: a, toEntryId: b, relationType: 'blocks',
				confidence: 1.0, confidenceTag: 'extracted', provenance: 'manual',
				createdAt: old, updatedAt: old,
			});
			// Ambiguous but NOT llm-provenance — also retained.
			staleAmbiguousManual = await ctx.db.insert('knowledgeRelations', {
				fromEntryId: a, toEntryId: b, relationType: 'supersedes',
				confidence: 0.4, confidenceTag: 'ambiguous', provenance: 'manual',
				createdAt: old, updatedAt: old,
			});
		});

		const r = await t.mutation(internal.knowledge.relationDecay.reapAmbiguousEdges, {});
		// Three edges carry the 'ambiguous' tag; only the stale LLM one is reaped.
		expect(r.examined).toBe(3);
		expect(r.reaped).toBe(1);
		expect(r.done).toBe(true);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(staleAmbiguousLlm)).toBeNull();
			expect(await ctx.db.get(recentAmbiguousLlm)).not.toBeNull();
			expect(await ctx.db.get(staleInferredLlm)).not.toBeNull();
			expect(await ctx.db.get(staleExtractedManual)).not.toBeNull();
			expect(await ctx.db.get(staleAmbiguousManual)).not.toBeNull();
		});
	});
});
