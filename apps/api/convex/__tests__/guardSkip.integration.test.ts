/**
 * D13 (ADR-0073) end to end: the security scan skips the model guard for
 * spam-score archived mail and for mail arriving while the agent is off, and
 * records the skip on the message (`securityFlags.guardNotRun`). Nothing
 * autonomous runs on such a message before the guard:
 *
 *   - a pipeline re-run starts at the scan, which runs the guard and drops the
 *     marker;
 *   - a path that resumes mid-pipeline (a later step, `resumeDraft`) fails the
 *     message instead of running;
 *   - knowledge extraction (the first-enable backfill reaches agent-off mail)
 *     and thread interpretation (a thread's history on first open) run the
 *     guard first, record it, and skip a message it flags.
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

describe('D13: the scan skips the guard and records it', () => {
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

describe('D13: re-processing requires the guard', () => {
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
		const { guardNotRun: _skip, ...ranFlags } = AGENT_OFF_FLAGS;
		const id = await insertMessage(t, { processingStatus: 'draft_ready', securityFlags: ranFlags });

		await t.action(internal.knowledge.extraction.extractFromMessage, { inboundMessageId: id });

		expect(callsTo(GUARD_PROMPT)).toBe(0);
		expect(callsTo(EXTRACT_PROMPT)).toBe(1);
	});
});

describe('D13: thread interpretation requires the guard', () => {
	async function seedTeamSource(t: Harness) {
		await enableFeatures(t, ['inbox']);
		const threadId = await t.run((ctx) =>
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
		const id = await insertMessage(t, {
			processingStatus: 'security_check',
			securityFlags: AGENT_OFF_FLAGS,
			threadId,
		});
		const source = { kind: 'inbound' as const, id };
		await t.run((ctx) => captureInterpretSource(ctx, { source, isLive: true }));
		return { id, source };
	}

	it('runs the guard before interpreting, and skips a message it flags', async () => {
		guardFlags = true;
		const t = convexTest(schema, modules);
		const { id, source } = await seedTeamSource(t);

		const result = await t.action(internal.mail.interpret.run.interpretMessage, { source });

		expect(result).toMatchObject({ status: 'skipped', errorCode: 'guard_flagged' });
		expect(callsTo(GUARD_PROMPT)).toBe(1);
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		const message = await read(t, id);
		expect(message.securityFlags?.guardNotRun).toBeUndefined();
		expect(message.securityFlags?.injectionDetected).toBe(true);
	});
});
