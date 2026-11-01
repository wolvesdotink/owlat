/**
 * The guard skip end to end: the security scan skips the model guard for
 * spam-score archived mail and for mail arriving while the agent is off, and
 * records the skip on the message (`securityFlags.guardNotRun`). Nothing
 * autonomous runs on such a message before the guard:
 *
 *   - a pipeline re-run starts at the scan, which runs the guard and drops the
 *     marker;
 *   - a path that resumes mid-pipeline (a later step, `resumeDraft`) fails the
 *     message instead of running;
 *   - knowledge extraction (the first-enable backfill reaches agent-off mail),
 *     thread interpretation (a thread's history on first open) and a
 *     briefing's conversation history run the guard first, record it, and
 *     skip a message it flags;
 *   - what the scan or a late guard already rejected (quarantine, malware, a
 *     malicious URL, a flagged injection) never reaches those consumers, with
 *     or without the marker.
 *
 * The LLM dispatch seam and the model factory are mocked; the walker, the
 * lifecycle, the scan and the extraction action are real.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { GUARD_REQUIRED_ERROR } from '../agent/steps/security_scan/disposition';
import { captureInterpretSource } from '../mail/interpret/sources';
import { enqueueHistoryPage } from '../mail/interpret/backfillSources';

const mocks = vi.hoisted(() => ({ runLlmObject: vi.fn() }));

vi.mock('../lib/llm/dispatch', async () => ({
	...(await vi.importActual<object>('../lib/llm/dispatch')),
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../lib/llmProvider')),
	resolveLanguageModel: vi.fn(async () => 'mock-model'),
}));
vi.mock('../lib/contactCountHelpers', async () => ({
	...(await vi.importActual<object>('../lib/contactCountHelpers')),
	incrementContactCount: vi.fn().mockResolvedValue(undefined),
	decrementContactCount: vi.fn().mockResolvedValue(undefined),
	getCachedContactCount: vi.fn().mockResolvedValue(0),
	reconcileContactCount: vi.fn().mockResolvedValue(undefined),
}));

const modules = import.meta.glob('../**/*.*s');

type Harness = ReturnType<typeof convexTest>;

const GUARD_PROMPT = 'security classifier';
const EXTRACT_PROMPT = 'Extract organizational knowledge';

let guardFlags = false;

function answerCalls() {
	mocks.runLlmObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
		if (prompt.includes(GUARD_PROMPT)) {
			return {
				object: guardFlags
					? { isInjection: true, confidence: 0.95, reason: 'manipulation attempt' }
					: { isInjection: false, confidence: 0.02, reason: 'benign' },
			};
		}
		if (prompt.includes(EXTRACT_PROMPT)) return { object: { entries: [] } };
		throw new Error(`unexpected model call: ${prompt.slice(0, 60)}`);
	});
}

const callsTo = (fragment: string) =>
	mocks.runLlmObject.mock.calls.filter(([opts]) =>
		(opts as { prompt: string }).prompt.includes(fragment)
	).length;

const CLEAN_BODY = 'Hello, could you tell me when my order 123 will ship? Thanks a lot.';
const SPAM = {
	subject: 'YOU HAVE WON A PRIZE',
	textBody: 'Congratulations winner! Act now, limited time: click here, buy now, free prize!!!!',
};

const AGENT_OFF_FLAGS = {
	injectionDetected: false,
	confidence: 0,
	spamScore: 0,
	phishingDetected: false,
	guardUnavailable: false,
	guardNotRun: { reason: 'agent_disabled' as const, at: 1 },
	scanTimestamp: 1,
};

async function insertMessage(
	t: Harness,
	fields: Partial<Doc<'inboundMessages'>> & {
		processingStatus: Doc<'inboundMessages'>['processingStatus'];
	}
): Promise<Id<'inboundMessages'>> {
	return t.run((ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `msg-${Math.random().toString(36).slice(2)}`,
			from: 'customer@example.com',
			to: 'support@owlat.app',
			subject: 'Order question',
			textBody: CLEAN_BODY,
			receivedAt: Date.now(),
			...fields,
		})
	);
}

const scanStep = (t: Harness, id: Id<'inboundMessages'>) =>
	t.action(internal.agent.walker.runStep, {
		inboundMessageId: id,
		kind: 'security_scan',
		input: { inboundMessageId: id },
	});

const read = (t: Harness, id: Id<'inboundMessages'>) =>
	t.run(async (ctx) => (await ctx.db.get(id))!);

beforeEach(() => {
	vi.useFakeTimers();
	guardFlags = false;
	mocks.runLlmObject.mockReset();
	answerCalls();
});

describe('the scan skips the guard and records it', () => {
	it('agent off: no guard call, the run stops in security_check, the marker is stored', async () => {
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, { processingStatus: 'security_check' });

		await scanStep(t, id);

		const message = await read(t, id);
		expect(callsTo(GUARD_PROMPT)).toBe(0);
		expect(message.processingStatus).toBe('security_check');
		expect(message.securityFlags?.guardNotRun?.reason).toBe('agent_disabled');
	});

	it('spam score: no guard call, archived as spam with the marker', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, { processingStatus: 'security_check', ...SPAM });

		await scanStep(t, id);

		const message = await read(t, id);
		expect(callsTo(GUARD_PROMPT)).toBe(0);
		expect(message.processingStatus).toBe('archived');
		expect(message.archiveReason).toBe('spam');
		expect(message.securityFlags?.guardNotRun?.reason).toBe('spam_archived');
	});
});

describe('re-processing requires the guard', () => {
	it('a re-run with the agent on runs the guard first and drops the marker', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'security_check',
			securityFlags: AGENT_OFF_FLAGS,
		});

		await scanStep(t, id);

		const message = await read(t, id);
		expect(callsTo(GUARD_PROMPT)).toBe(1);
		expect(message.processingStatus).toBe('classifying');
		expect(message.securityFlags?.guardNotRun).toBeUndefined();
	});

	it('a step after the scan refuses a message whose guard was skipped', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: AGENT_OFF_FLAGS,
		});

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: id,
			kind: 'context_retrieval',
			input: { inboundMessageId: id },
		});

		const message = await read(t, id);
		expect(message.processingStatus).toBe('failed');
		expect(message.errorMessage).toBe(GUARD_REQUIRED_ERROR);
		const actions = await t.run((ctx) =>
			ctx.db
				.query('agentActions')
				.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', id))
				.collect()
		);
		expect(actions).toEqual([]);
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});

	it('resumeDraft refuses a message whose guard was skipped', async () => {
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, {
			processingStatus: 'drafting',
			securityFlags: AGENT_OFF_FLAGS,
		});

		await t.action(internal.agent.walker.resumeDraft, { inboundMessageId: id });

		const message = await read(t, id);
		expect(message.processingStatus).toBe('failed');
		expect(message.errorMessage).toBe(GUARD_REQUIRED_ERROR);
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});

	it('knowledge extraction runs the guard first, records it, then extracts', async () => {
		const t = convexTest(schema, modules);
		// Extraction runs only with the knowledge graph on.
		await enableFeatures(t, ['ai.knowledge']);
		const id = await insertMessage(t, {
			processingStatus: 'security_check',
			securityFlags: AGENT_OFF_FLAGS,
		});

		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId: id });

		const message = await read(t, id);
		expect(callsTo(GUARD_PROMPT)).toBe(1);
		expect(callsTo(EXTRACT_PROMPT)).toBe(1);
		// Guard order: the guard call came before the extraction call.
		const prompts = mocks.runLlmObject.mock.calls.map(([o]) => (o as { prompt: string }).prompt);
		expect(prompts[0]).toContain(GUARD_PROMPT);
		expect(message.securityFlags?.guardNotRun).toBeUndefined();
		expect(message.securityFlags?.guardUnavailable).toBe(false);
		// The status is untouched: the late guard records, it does not route.
		expect(message.processingStatus).toBe('security_check');
	});

	it('knowledge extraction stops when the late guard flags the message', async () => {
		guardFlags = true;
		const t = convexTest(schema, modules);
		// Extraction runs only with the knowledge graph on.
		await enableFeatures(t, ['ai.knowledge']);
		const id = await insertMessage(t, {
			processingStatus: 'archived',
			securityFlags: { ...AGENT_OFF_FLAGS, guardNotRun: { reason: 'spam_archived', at: 1 } },
		});

		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId: id });

		const message = await read(t, id);
		expect(callsTo(GUARD_PROMPT)).toBe(1);
		expect(callsTo(EXTRACT_PROMPT)).toBe(0);
		expect(message.securityFlags).toMatchObject({
			injectionDetected: true,
			injectionType: 'llm_prompt_injection',
			flaggedContent: 'manipulation attempt',
		});
		expect(message.securityFlags?.guardNotRun).toBeUndefined();
	});

	it('knowledge extraction leaves a message whose guard ran alone', async () => {
		const t = convexTest(schema, modules);
		// Extraction runs only with the knowledge graph on.
		await enableFeatures(t, ['ai.knowledge']);
		const { guardNotRun: _skip, ...ranFlags } = AGENT_OFF_FLAGS;
		const id = await insertMessage(t, { processingStatus: 'draft_ready', securityFlags: ranFlags });

		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId: id });

		expect(callsTo(GUARD_PROMPT)).toBe(0);
		expect(callsTo(EXTRACT_PROMPT)).toBe(1);
	});
});

async function insertThread(t: Harness): Promise<Id<'conversationThreads'>> {
	return t.run((ctx) =>
		ctx.db.insert('conversationThreads', {
			subject: 'Order question',
			normalizedSubject: 'order question',
			contactIdentifier: 'customer@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: Date.now(),
			firstMessageAt: Date.now(),
			createdAt: Date.now(),
		})
	);
}

/** A deterministic quarantine: no guard-skip marker, the injection flags alone. */
const QUARANTINE_FLAGS = {
	injectionDetected: true,
	injectionType: 'prompt_injection',
	confidence: 0.85,
	spamScore: 0,
	phishingDetected: false,
	guardUnavailable: false,
	scanTimestamp: 1,
};
const { guardNotRun: _ran, ...CLEAN_FLAGS } = AGENT_OFF_FLAGS;

/** What the scan or a late guard already rejected, one of each kind. */
const REJECTED: Array<[string, Partial<Doc<'inboundMessages'>>]> = [
	['an injection quarantine', { processingStatus: 'quarantined', securityFlags: QUARANTINE_FLAGS }],
	['malware', { processingStatus: 'quarantined', virusVerdict: 'infected' }],
	[
		'a malicious URL',
		{ processingStatus: 'quarantined', securityFlags: { ...CLEAN_FLAGS, phishingDetected: true } },
	],
];

async function captured(t: Harness, id: Id<'inboundMessages'>) {
	const source = { kind: 'inbound' as const, id };
	await t.run((ctx) => captureInterpretSource(ctx, { source, isLive: true }));
	return source;
}

describe('thread interpretation requires the guard', () => {
	it('runs the guard before interpreting, and skips a message it flags', async () => {
		guardFlags = true;
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const id = await insertMessage(t, {
			processingStatus: 'security_check',
			securityFlags: AGENT_OFF_FLAGS,
			threadId: await insertThread(t),
		});
		const source = await captured(t, id);

		const result = await t.action(internal.mail.interpret.run.interpretMessage, { source });

		expect(result).toMatchObject({ status: 'skipped', errorCode: 'guard_flagged' });
		expect(callsTo(GUARD_PROMPT)).toBe(1);
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		const message = await read(t, id);
		expect(message.securityFlags?.guardNotRun).toBeUndefined();
		expect(message.securityFlags?.injectionDetected).toBe(true);

		// F2: the cleared marker does not reopen the message to later consumers.
		const again = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(again).toMatchObject({ status: 'skipped', errorCode: 'guard_flagged' });
		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId: id });
		expect(callsTo(GUARD_PROMPT)).toBe(1);
		expect(callsTo(EXTRACT_PROMPT)).toBe(0);
	});

	it('repeated extraction after a flagged late guard makes no further model call', async () => {
		guardFlags = true;
		const t = convexTest(schema, modules);
		// Extraction runs only with the knowledge graph on.
		await enableFeatures(t, ['ai.knowledge']);
		const id = await insertMessage(t, {
			processingStatus: 'security_check',
			securityFlags: AGENT_OFF_FLAGS,
		});

		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId: id });
		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId: id });

		expect(callsTo(GUARD_PROMPT)).toBe(1);
		expect(callsTo(EXTRACT_PROMPT)).toBe(0);
	});
});

describe('#1339: what the scan rejected never reaches extraction or interpretation', () => {
	it.each(REJECTED)('extraction skips %s with no model call', async (_, fields) => {
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, { processingStatus: 'quarantined', ...fields });

		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId: id });

		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});

	it.each(REJECTED)('interpretation skips %s with no model call', async (_, fields) => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const id = await insertMessage(t, {
			processingStatus: 'quarantined',
			...fields,
			threadId: await insertThread(t),
		});
		const source = await captured(t, id);

		const result = await t.action(internal.mail.interpret.run.interpretMessage, { source });

		expect(result).toMatchObject({ status: 'skipped', errorCode: 'guard_flagged' });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});

	it('the first-enable backfill extracts the clean message and none of the rejected ones', async () => {
		vi.useRealTimers();
		const t = convexTest(schema, modules);
		// The backfill's extractions run only with the knowledge graph on.
		await enableFeatures(t, ['ai.agent', 'ai.knowledge']);
		await insertMessage(t, { processingStatus: 'draft_ready', securityFlags: CLEAN_FLAGS });
		for (const [, fields] of REJECTED) {
			await insertMessage(t, { processingStatus: 'quarantined', ...fields });
		}
		const jobId = await t.run((ctx) =>
			ctx.db.insert('knowledgeBackfillJobs', {
				status: 'running',
				triggeredBy: 'test',
				totalCount: 4,
				scannedCount: 0,
				extractedCount: 0,
				skippedCount: 0,
				errorCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			})
		);

		await t.action(internal.knowledge.messageBackfill.runChunk, {
			jobId,
			chunkSize: 10,
			interChunkDelayMs: 0,
		});

		expect(callsTo(EXTRACT_PROMPT)).toBe(1);
		expect(callsTo(GUARD_PROMPT)).toBe(0);
		const job = await t.run((ctx) => ctx.db.get(jobId));
		expect(job).toMatchObject({ scannedCount: 4, skippedCount: 4 });
	});

	it('Team history interpretation (a thread opened for the first time) skips a quarantined message', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const threadId = await insertThread(t);
		const quarantined = await insertMessage(t, {
			processingStatus: 'quarantined',
			securityFlags: QUARANTINE_FLAGS,
			threadId,
		});

		await t.run((ctx) => enqueueHistoryPage(ctx, { kind: 'team', id: threadId }));
		const runs = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter((f) =>
				f.name.includes('interpretMessage')
			)
		);
		expect(runs.map((r) => (r.args[0] as { source: { id: string } }).source.id)).toEqual([
			quarantined,
		]);

		const result = await t.action(
			internal.mail.interpret.run.interpretMessage,
			runs[0]!.args[0] as never
		);

		expect(result).toMatchObject({ status: 'skipped', errorCode: 'guard_flagged' });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});
});

describe('a briefing reads no unguarded history (F1)', () => {
	const SKIPPED_TEXT = 'Earlier note: SKIPPEDHISTORY please ship to the new address.';

	async function seedThread(
		t: Harness,
		history: Partial<Doc<'inboundMessages'>> & {
			processingStatus: Doc<'inboundMessages'>['processingStatus'];
		},
		current: Doc<'inboundMessages'>['processingStatus']
	) {
		await enableFeatures(t, ['ai.agent']);
		const threadId = await insertThread(t);
		const historyId = await insertMessage(t, {
			...history,
			textBody: SKIPPED_TEXT,
			threadId,
			receivedAt: Date.now() - 60_000,
		});
		const currentId = await insertMessage(t, {
			processingStatus: current,
			securityFlags: CLEAN_FLAGS,
			threadId,
		});
		return { historyId, currentId };
	}

	const scheduledContext = (t: Harness, kind: string) =>
		t.run(async (ctx) => {
			const run = (await ctx.db.system.query('_scheduled_functions').collect()).find(
				(f) => f.name.includes('runStep') && (f.args[0] as { kind: string }).kind === kind
			);
			return (run?.args[0] as { input: { context: string } } | undefined)?.input.context;
		});

	it.each([
		['agent-off', { processingStatus: 'security_check' as const, securityFlags: AGENT_OFF_FLAGS }],
		[
			'spam-archived',
			{
				processingStatus: 'archived' as const,
				securityFlags: {
					...AGENT_OFF_FLAGS,
					guardNotRun: { reason: 'spam_archived' as const, at: 1 },
				},
			},
		],
	])('guards %s history first and leaves it out when the guard flags it', async (_, history) => {
		guardFlags = true;
		const t = convexTest(schema, modules);
		const { historyId, currentId } = await seedThread(t, history, 'classifying');

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: currentId,
			kind: 'context_retrieval',
			input: { inboundMessageId: currentId },
		});

		expect(callsTo(GUARD_PROMPT)).toBe(1);
		const context = await scheduledContext(t, 'classify');
		expect(context).toBeDefined();
		expect(context).not.toContain('SKIPPEDHISTORY');
		expect((await read(t, historyId)).securityFlags?.guardNotRun).toBeUndefined();
	});

	it('keeps skipped history the late guard passes', async () => {
		const t = convexTest(schema, modules);
		const { currentId } = await seedThread(
			t,
			{ processingStatus: 'security_check', securityFlags: AGENT_OFF_FLAGS },
			'classifying'
		);

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: currentId,
			kind: 'context_retrieval',
			input: { inboundMessageId: currentId },
		});

		expect(callsTo(GUARD_PROMPT)).toBe(1);
		expect(await scheduledContext(t, 'classify')).toContain('SKIPPEDHISTORY');
	});

	it('leaves quarantined history out with no model call', async () => {
		const t = convexTest(schema, modules);
		const { currentId } = await seedThread(
			t,
			{ processingStatus: 'quarantined', securityFlags: QUARANTINE_FLAGS },
			'classifying'
		);

		await t.action(internal.agent.walker.runStep, {
			inboundMessageId: currentId,
			kind: 'context_retrieval',
			input: { inboundMessageId: currentId },
		});

		expect(callsTo(GUARD_PROMPT)).toBe(0);
		expect(await scheduledContext(t, 'classify')).not.toContain('SKIPPEDHISTORY');
	});

	it('resumeDraft guards skipped history before drafting', async () => {
		guardFlags = true;
		const t = convexTest(schema, modules);
		const { currentId } = await seedThread(
			t,
			{ processingStatus: 'security_check', securityFlags: AGENT_OFF_FLAGS },
			'drafting'
		);

		await t.action(internal.agent.walker.resumeDraft, { inboundMessageId: currentId });

		expect(callsTo(GUARD_PROMPT)).toBe(1);
		const context = await scheduledContext(t, 'draft');
		expect(context).toBeDefined();
		expect(context).not.toContain('SKIPPEDHISTORY');
	});
});

describe('overlapping late guards merge monotonically', () => {
	const FLAGGED = {
		flagged: { confidence: 0.95, reason: 'manipulation attempt' },
		isIncomplete: false,
	};
	const BENIGN = { isIncomplete: false };

	async function lateGuard(
		t: Harness,
		id: Id<'inboundMessages'>,
		verdict: { flagged?: { confidence: number; reason: string }; isIncomplete: boolean },
		generation = AGENT_OFF_FLAGS.scanTimestamp
	) {
		return t.mutation(internal.inbox.stepOutputs.recordLateGuard, {
			inboundMessageId: id,
			generation,
			verdict,
		});
	}

	it('benign first, flagged second: the rejection still lands, and both read it after', async () => {
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, {
			processingStatus: 'security_check',
			securityFlags: AGENT_OFF_FLAGS,
		});

		expect(await lateGuard(t, id, BENIGN)).toBe('clear');
		expect(await lateGuard(t, id, FLAGGED)).toBe('rejected');

		const flags = (await read(t, id)).securityFlags!;
		expect(flags).toMatchObject({
			injectionDetected: true,
			flaggedContent: 'manipulation attempt',
		});
		expect(flags.guardNotRun).toBeUndefined();
		expect(flags.scanTimestamp).toBe(AGENT_OFF_FLAGS.scanTimestamp);
	});

	it('flagged first, benign second: the benign caller gets the persisted rejection', async () => {
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, {
			processingStatus: 'security_check',
			securityFlags: AGENT_OFF_FLAGS,
		});

		expect(await lateGuard(t, id, FLAGGED)).toBe('rejected');
		expect(await lateGuard(t, id, BENIGN)).toBe('rejected');

		expect((await read(t, id)).securityFlags).toMatchObject({
			injectionDetected: true,
			confidence: 0.95,
		});
	});

	it('an incomplete guard run turns guardUnavailable on and a complete one never turns it off', async () => {
		const t = convexTest(schema, modules);
		const id = await insertMessage(t, {
			processingStatus: 'security_check',
			securityFlags: AGENT_OFF_FLAGS,
		});

		await lateGuard(t, id, { isIncomplete: true });
		await lateGuard(t, id, BENIGN);

		expect((await read(t, id)).securityFlags?.guardUnavailable).toBe(true);
	});

	it('drops a result from an older scan generation and answers with the newer scan', async () => {
		const t = convexTest(schema, modules);
		const { guardNotRun: _gone, ...rescanned } = AGENT_OFF_FLAGS;
		const id = await insertMessage(t, {
			processingStatus: 'classifying',
			securityFlags: { ...rescanned, scanTimestamp: 2 },
		});

		expect(await lateGuard(t, id, FLAGGED, 1)).toBe('clear');
		expect((await read(t, id)).securityFlags?.injectionDetected).toBe(false);
	});

	it('a consumer acts on the persisted standing, not on its own benign verdict', async () => {
		const t = convexTest(schema, modules);
		// Extraction runs only with the knowledge graph on.
		await enableFeatures(t, ['ai.knowledge']);
		const id = await insertMessage(t, {
			processingStatus: 'security_check',
			securityFlags: AGENT_OFF_FLAGS,
		});
		// An overlapping consumer's late guard flagged the message while this
		// extraction's own guard run (benign, guardFlags = false) was in flight.
		mocks.runLlmObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
			if (prompt.includes(GUARD_PROMPT)) {
				await lateGuard(t, id, FLAGGED);
				return { object: { isInjection: false, confidence: 0.02, reason: 'benign' } };
			}
			if (prompt.includes(EXTRACT_PROMPT)) return { object: { entries: [] } };
			throw new Error('unexpected model call');
		});

		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId: id });

		expect(callsTo(GUARD_PROMPT)).toBe(1);
		expect(callsTo(EXTRACT_PROMPT)).toBe(0);
		expect((await read(t, id)).securityFlags?.injectionDetected).toBe(true);
	});
});
