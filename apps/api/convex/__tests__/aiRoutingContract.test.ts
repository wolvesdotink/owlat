/**
 * The AI routing contract: every new table and field validates a
 * realistic row, every index the later lanes build on exists with the fields
 * they query by, and the pure key helpers spell their keys one way.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { modules } from '../mail/__tests__/helpers.testlib';
import {
	embeddingSpaceEntryKey,
	embeddingSpaceIdentityKey,
	type EmbeddingSpaceIdentity,
} from '../lib/aiRouting/embeddingKeys';
import { guardRequirement, isGuardRequiredBeforeAutonomy } from '../lib/aiRouting/guardRecord';
import {
	ledgerRowBudgetClass,
	ledgerRowMicrousd,
	spendPeriodKeys,
	usdToMicrousd,
} from '../lib/aiRouting/spendPeriods';
import { utcMonthKey, utcMonthStart } from '../lib/clock';
import { AI_ROUTING_TABLES, aiRoutingTables } from '../schema/aiRouting';
import { embeddingSpaceTables } from '../schema/embeddingSpaces';

type TableName = keyof typeof schema.tables;

function indexesOf(table: TableName): Record<string, string[]> {
	return Object.fromEntries(
		schema.tables[table][' indexes']().map((index) => [index.indexDescriptor, index.fields])
	);
}

function vectorIndexesOf(table: TableName): Record<string, { field: string; filters: string[] }> {
	const definition = schema.tables[table] as unknown as {
		vectorIndexes: { indexDescriptor: string; vectorField: string; filterFields: string[] }[];
	};
	return Object.fromEntries(
		definition.vectorIndexes.map((index) => [
			index.indexDescriptor,
			{ field: index.vectorField, filters: index.filterFields },
		])
	);
}

/** The indexes later lanes query by: [table, index, fields]. */
const EXPECTED_INDEXES: [TableName, string, string[]][] = [
	['llmUsageEvents', 'by_reservation_id', ['reservationId']],
	['llmSpendPeriods', 'by_period', ['periodKind', 'periodKey', 'plane', 'budgetClass']],
	['llmReservations', 'by_reservation_id', ['reservationId']],
	['llmReservations', 'by_root_request_id', ['rootRequestId']],
	['llmReservations', 'by_status_and_plane', ['status', 'plane', 'budgetClass']],
	['llmReservations', 'by_status_and_expires_at', ['status', 'expiresAt']],
	['llmReservations', 'by_status_and_updated_at', ['status', 'updatedAt']],
	['decisionArtifacts', 'by_artifact_key', ['artifactKey']],
	['decisionArtifacts', 'by_inbound_message', ['inboundMessageId', 'task', 'kind']],
	['decisionArtifacts', 'by_mail_message', ['mailMessageId', 'task']],
	['decisionArtifacts', 'by_mailbox', ['mailboxId']],
	['decisionArtifacts', 'by_task_and_kind', ['task', 'kind', 'createdAt']],
	['decisionArtifacts', 'by_expires_at', ['expiresAt']],
	[
		'senderMemory',
		'by_lookup',
		['scope', 'mailboxId', 'senderDigest', 'task', 'matchKind', 'matchKey'],
	],
	['senderMemory', 'by_contact', ['contactId']],
	['senderMemory', 'by_expires_at', ['expiresAt']],
	['embeddingSpaces', 'by_identity_key', ['identityKey']],
	['embeddingSpaces', 'by_state', ['state']],
	['embeddingAttestations', 'by_space', ['spaceId']],
	['embeddingAttestations', 'by_status', ['status']],
	['embeddingReembedJobs', 'by_status', ['status']],
	['embeddingReembedJobs', 'by_target_space', ['targetSpaceId']],
	[
		'interpretSources',
		'by_mail_thread_deferred_order',
		['mailThreadId', 'isDeferred', 'sourceOrderKey'],
	],
	['knowledgeEntries', 'by_embedding_space', ['embeddingSpaceId', 'embeddingGeneratedAt']],
	['knowledgeEntries', 'by_secondary_embedding_space', ['secondaryEmbeddingSpaceId']],
	['semanticFiles', 'by_embedding_space', ['embeddingSpaceId', 'embeddingGeneratedAt']],
	['semanticFiles', 'by_secondary_embedding_space', ['secondaryEmbeddingSpaceId']],
];

describe('AI routing indexes', () => {
	it('lists every new table once for the tenant and deletion registries', () => {
		expect([...AI_ROUTING_TABLES].sort()).toEqual(
			[...Object.keys(aiRoutingTables), ...Object.keys(embeddingSpaceTables)].sort()
		);
	});

	it.each(EXPECTED_INDEXES)('declares %s.%s on %j', (table, index, fields) => {
		expect(indexesOf(table)[index]).toEqual(fields);
	});

	it.each<[TableName, string, string, string[]]>([
		[
			'knowledgeEntries',
			'vector_knowledge',
			'embedding',
			['entryType', 'embeddingSpaceId', 'embeddingSpaceEntryKey'],
		],
		[
			'knowledgeEntries',
			'vector_knowledge_secondary',
			'secondaryEmbedding',
			['secondaryEmbeddingSpaceId', 'secondaryEmbeddingSpaceEntryKey'],
		],
		['semanticFiles', 'vector_files', 'embedding', ['embeddingSpaceId']],
		[
			'semanticFiles',
			'vector_files_secondary',
			'secondaryEmbedding',
			['secondaryEmbeddingSpaceId'],
		],
	])('filters %s.%s (%s) by embedding space', (table, index, field, filters) => {
		expect(vectorIndexesOf(table)[index]).toEqual({ field, filters });
	});
});

const NOW = Date.UTC(2026, 9, 12, 9, 30);
const IDENTITY: EmbeddingSpaceIdentity = {
	provider: 'local',
	endpoint: 'native',
	model: 'nomic-embed-text',
	dimensions: 768,
	revision: 'sha256:0f1e',
	quantization: 'f16',
};

describe('AI routing rows validate', () => {
	it('stores a realistic row in every new table and finds it by its index', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const spaceId = await ctx.db.insert('embeddingSpaces', {
				...IDENTITY,
				identityKey: embeddingSpaceIdentityKey(IDENTITY),
				source: 'stored_config',
				state: 'active',
				slot: 'primary',
				configVersion: 3,
				activatedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			});
			const attestationId = await ctx.db.insert('embeddingAttestations', {
				spaceId,
				source: 'attestation',
				cohort: { tables: ['knowledgeEntries', 'semanticFiles'], writtenUntil: NOW },
				statement: 'The local embedder has served nomic-embed-text f16 since install.',
				attestedBy: 'admin-1',
				attestedAt: NOW,
				status: 'applying',
				phase: 'knowledgeEntries',
				rowsAssigned: 0,
				updatedAt: NOW,
			});
			await ctx.db.insert('embeddingReembedJobs', {
				kind: 'reembed',
				targetSpaceId: spaceId,
				status: 'running',
				isPaid: false,
				generation: 1,
				phase: 'semanticFiles',
				scannedCount: 0,
				embeddedCount: 0,
				skippedCount: 0,
				failedCount: 0,
				startedAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title: 'Opening hours',
				content: 'Open nine to five.',
				sourceType: 'manual',
				embedding: [0.1, 0.2],
				confidence: 0.9,
				lastValidatedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
				embeddingGeneratedAt: NOW,
				embeddingSpaceId: spaceId,
				embeddingProvenance: 'attestation',
				embeddingAttestationId: attestationId,
				embeddingSpaceEntryKey: embeddingSpaceEntryKey(spaceId, 'fact'),
			});
			await ctx.db.insert('aiRoutingPolicy', {
				policyVersion: 2,
				triageBundle: 'shadow',
				shadowCapUsd: 1,
				promptCacheTasks: ['mail.draft'],
				updatedAt: NOW,
				updatedBy: 'admin-1',
			});
			await ctx.db.insert('llmSpendPeriods', {
				periodKind: 'day',
				periodKey: spendPeriodKeys(NOW).day,
				plane: 'language',
				budgetClass: 'triage',
				settledMicrousd: 1200,
				estimatedMicrousd: 0,
				eventCount: 3,
				generation: 1,
				updatedAt: NOW,
			});
			await ctx.db.insert('llmSpendAggregateState', {
				status: 'rebuilding',
				generation: 1,
				rebuildCutoff: NOW,
				scannedCount: 0,
				startedAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('llmReservations', {
				reservationId: 'res-1',
				rootRequestId: 'root-1',
				plane: 'language',
				task: 'mail.classify',
				budgetClass: 'triage',
				priority: 'pipeline',
				heldMicrousd: 600,
				status: 'held',
				maxAttempts: 3,
				policyVersion: 2,
				expiresAt: NOW + 60_000,
				createdAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('llmUsageEvents', {
				feature: 'agent_classify',
				promptTokens: 4000,
				completionTokens: 300,
				totalTokens: 4300,
				costUsd: 0.00055,
				createdAt: NOW,
				plane: 'language',
				requestId: 'call-1',
				rootRequestId: 'root-1',
				parentCallId: 'parent-1',
				task: 'mail.classify',
				policyVersion: 2,
				attempt: 1,
				endpoint: 'openai-native',
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 120,
				latencyMs: 840,
				qualityResult: 'passed',
				priceVersion: '2026-10-11',
				isEstimated: false,
				costMicrousd: 550,
				budgetClass: 'triage',
				reservationId: 'res-1',
			});
			const inboundMessageId = await ctx.db.insert('inboundMessages', {
				messageId: '<m1@example.com>',
				from: 'sender@example.com',
				to: 'team@example.com',
				subject: 'Hello',
				processingStatus: 'draft_ready',
				receivedAt: NOW,
				mtaSpamVerdict: 'ham',
				mtaSpamScore: 1.5,
				budgetHold: {
					reason: 'daily_ceiling',
					missingJudgments: ['classify', 'draft'],
					at: NOW,
				},
				securityFlags: {
					injectionDetected: false,
					confidence: 0,
					spamScore: 85,
					guardNotRun: { reason: 'spam_archived', at: NOW },
					scanTimestamp: NOW,
				},
			});
			await ctx.db.insert('decisionArtifacts', {
				artifactKey: 'mail.category|inbound|m1|h1|2',
				task: 'mail.category',
				kind: 'shadow',
				status: 'complete',
				subjectKind: 'inbound_message',
				inboundMessageId,
				contentHash: 'h1',
				policyVersion: 2,
				provenance: {
					provider: 'typesafe',
					modelUsed: 'jev-1.13.0',
					endpoint: 'typesafe-native',
					questionSetId: 'mail.category',
					questionSetVersion: 1,
				},
				calibration: { isAdapterCalibrated: true, language: 'en' },
				answers: JSON.stringify({ category: 'support' }),
				answersVersion: 1,
				baseline: JSON.stringify({ category: 'support' }),
				baselineVersion: 1,
				isAgreement: true,
				expiresAt: NOW + 90 * 86_400_000,
				createdAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('senderMemory', {
				scope: 'team_inbox',
				senderDigest: 'ab12',
				authBasis: 'dmarc_pass',
				task: 'mail.category',
				matchKind: 'template',
				matchKey: 'fp-1',
				fingerprintVersion: 1,
				policyVersion: 2,
				modelIdentity: 'typesafe/jev-1.13.0',
				outcome: JSON.stringify({ category: 'notification' }),
				outcomeVersion: 1,
				hitCount: 0,
				expiresAt: NOW + 30 * 86_400_000,
				createdAt: NOW,
				updatedAt: NOW,
			});

			const space = await ctx.db
				.query('embeddingSpaces')
				.withIndex('by_identity_key', (q) =>
					q.eq('identityKey', embeddingSpaceIdentityKey(IDENTITY))
				)
				.unique();
			expect(space?._id).toBe(spaceId);
			const inSpace = await ctx.db
				.query('knowledgeEntries')
				.withIndex('by_embedding_space', (q) => q.eq('embeddingSpaceId', spaceId))
				.collect();
			expect(inSpace).toHaveLength(1);
			const unknown = await ctx.db
				.query('knowledgeEntries')
				.withIndex('by_embedding_space', (q) => q.eq('embeddingSpaceId', undefined))
				.collect();
			expect(unknown).toEqual([]);
			const held = await ctx.db
				.query('llmReservations')
				.withIndex('by_status_and_plane', (q) =>
					q.eq('status', 'held').eq('plane', 'language').eq('budgetClass', 'triage')
				)
				.collect();
			expect(held.map((row) => row.heldMicrousd)).toEqual([600]);
			const rows = await ctx.db
				.query('llmUsageEvents')
				.withIndex('by_reservation_id', (q) => q.eq('reservationId', 'res-1'))
				.collect();
			expect(rows.map(ledgerRowMicrousd)).toEqual([550]);
			const bucket = await ctx.db
				.query('llmSpendPeriods')
				.withIndex('by_period', (q) =>
					q
						.eq('periodKind', 'day')
						.eq('periodKey', '2026-10-12')
						.eq('plane', 'language')
						.eq('budgetClass', 'triage')
				)
				.unique();
			expect(bucket?.settledMicrousd).toBe(1200);
			const artifacts = await ctx.db
				.query('decisionArtifacts')
				.withIndex('by_inbound_message', (q) =>
					q.eq('inboundMessageId', inboundMessageId).eq('task', 'mail.category')
				)
				.collect();
			expect(artifacts).toHaveLength(1);
			const memory = await ctx.db
				.query('senderMemory')
				.withIndex('by_lookup', (q) =>
					q
						.eq('scope', 'team_inbox')
						.eq('mailboxId', undefined)
						.eq('senderDigest', 'ab12')
						.eq('task', 'mail.category')
				)
				.collect();
			expect(memory).toHaveLength(1);
		});
	});
});

describe('guard record', () => {
	const scanned = { injectionDetected: false, confidence: 0, scanTimestamp: NOW };

	it('needs the guard when no scan is recorded or the guard was skipped', () => {
		expect(guardRequirement(undefined)).toBe('not_scanned');
		expect(
			guardRequirement({ ...scanned, guardNotRun: { reason: 'agent_disabled', at: NOW } })
		).toBe('guard_not_run');
		expect(isGuardRequiredBeforeAutonomy(undefined)).toBe(true);
	});

	it('is satisfied once the guard ran, even when it failed open', () => {
		expect(guardRequirement(scanned)).toBe('satisfied');
		expect(isGuardRequiredBeforeAutonomy({ ...scanned, guardUnavailable: true })).toBe(false);
	});
});

describe('spend period keys and money', () => {
	it('buckets a moment into its UTC day and month', () => {
		expect(spendPeriodKeys(NOW)).toEqual({ day: '2026-10-12', month: '2026-10' });
		expect(spendPeriodKeys(Date.UTC(2026, 11, 31, 23, 59, 59))).toEqual({
			day: '2026-12-31',
			month: '2026-12',
		});
		expect(utcMonthStart(NOW)).toBe(Date.UTC(2026, 9, 1));
		expect(utcMonthKey(Number.NaN)).toBe('');
		expect(utcMonthStart(Number.POSITIVE_INFINITY)).toBe(0);
	});

	it('rounds money up to whole micro-USD without float noise', () => {
		expect(usdToMicrousd(0.1)).toBe(100_000);
		expect(usdToMicrousd(0.000123)).toBe(123);
		expect(usdToMicrousd(0.0000001)).toBe(1);
		expect(usdToMicrousd(0)).toBe(0);
		expect(usdToMicrousd(-1)).toBe(0);
		expect(usdToMicrousd(Number.NaN)).toBe(0);
	});

	it('prefers the stored integer cost and reads legacy rows as standard spend', () => {
		expect(ledgerRowMicrousd({ costUsd: 0.5, costMicrousd: 7 })).toBe(7);
		expect(ledgerRowMicrousd({ costUsd: 0.5, costMicrousd: 1.5 })).toBe(500_000);
		expect(ledgerRowBudgetClass({ costUsd: 0 })).toBe('standard');
		expect(ledgerRowBudgetClass({ costUsd: 0, budgetClass: 'shadow' })).toBe('shadow');
	});
});

describe('embedding keys', () => {
	it('gives one identity one key, and tells apart identities a separator could merge', () => {
		expect(embeddingSpaceIdentityKey(IDENTITY)).toBe(embeddingSpaceIdentityKey({ ...IDENTITY }));
		const { revision: _revision, ...unrevised } = IDENTITY;
		expect(embeddingSpaceIdentityKey(unrevised)).not.toBe(embeddingSpaceIdentityKey(IDENTITY));
		expect(embeddingSpaceIdentityKey({ ...IDENTITY, model: 'a|b', endpoint: 'c' })).not.toBe(
			embeddingSpaceIdentityKey({ ...IDENTITY, model: 'a', endpoint: 'b|c' })
		);
	});

	it('composes the space-and-type vector filter key', () => {
		expect(embeddingSpaceEntryKey('space1' as Id<'embeddingSpaces'>, 'policy')).toBe(
			'space1:policy'
		);
	});
});
