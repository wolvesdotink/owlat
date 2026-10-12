/**
 * The task-policy catalog reproduces today's routes (ADR-0073, SPEC §2): the
 * tier each call site resolves through `lib/llmProvider.ts` today, the attempt
 * budget and deadline it runs with, and the ledger feature it records under.
 * The table below is the call-site inventory taken when the catalog landed; a
 * change to a route has to change this table too.
 */

import { describe, expect, it } from 'vitest';
import { AI_TASK_NAMES, type AiTaskName } from '@owlat/shared/aiRouting';
import { TASK_POLICIES, taskForFeature, taskPolicy, type LlmTier } from '../taskPolicy';
import {
	INTERACTIVE_LLM_ATTEMPTS,
	INTERACTIVE_LLM_DEADLINE_MS,
	MAX_LLM_ATTEMPTS,
} from '../retryPolicy';
import { PLUGIN_LLM_MAX_OUTPUT_TOKENS } from '../../../plugins/llmRequest';
import { CONNECTION_PROBE_FEATURE } from '../../decision/catalog';

/** feature tag recorded today → [task, tiers the call sites use today] */
const TODAY: Record<string, [AiTaskName, readonly LlmTier[]]> = {
	agent_security_scan: ['mail.guard', ['fast']],
	agent_classify: ['mail.classify', ['fast']],
	postbox_category: ['mail.classify', ['fast']],
	interpret: ['mail.extract', ['fast']],
	postbox_commitment: ['mail.extract', ['fast']],
	interpret_verify: ['mail.verify', ['fast']],
	// Team Inbox clarifies on fast; Postbox samples and judges on capable;
	// Answer mode samples by the eagerness dial and judges on capable.
	agent_clarify: ['mail.clarify', ['fast', 'capable']],
	postbox_clarify_diverge: ['mail.clarify', ['fast', 'capable']],
	postbox_answer_diverge: ['mail.clarify', ['fast', 'capable']],
	agent_draft: ['mail.draft', ['capable', 'fast']],
	postbox_draft: ['mail.draft', ['capable', 'fast']],
	agent_draft_selfcheck: ['mail.draft_check', ['fast']],
	agent_outcome_sentiment: ['mail.outcome_sentiment', ['fast']],
	postbox_voice_profile: ['mail.voice_profile', ['fast']],
	postbox_answer_draft: ['mail.compose', ['capable', 'fast']],
	postbox_revise_draft: ['mail.compose', ['capable', 'fast']],
	answer_plan_coverage: ['mail.plan_coverage', ['fast']],
	postbox_suggest_replies: ['mail.suggest', ['fast']],
	postbox_complete_draft: ['mail.complete', ['fast']],
	postbox_ask_thread: ['mail.ask', ['capable']],
	postbox_rewrite_selection: ['mail.rewrite', ['capable', 'fast']],
	postbox_coach_draft: ['mail.coach', ['fast']],
	translate: ['mail.translate', ['fast']],
	handling_rule_compile: ['mail.rule_compile', ['fast']],
	knowledge_extract_message: ['knowledge.extract', ['fast']],
	knowledge_autolink: ['knowledge.relate', ['fast']],
	semantic_file: ['file.summarize', ['fast']],
	assistant_chat: ['assistant.answer', ['capable', 'fast']],
	chat_assistant: ['assistant.answer', ['capable', 'fast']],
	assistant_tool_draft: ['assistant.tool_draft', ['capable', 'fast']],
	visualization: ['analytics.visualize', ['capable']],
	visualization_title: ['analytics.visualize_title', ['fast']],
};

describe('task-policy catalog', () => {
	it('has exactly one entry per task name, stamped with its name', () => {
		expect(Object.keys(TASK_POLICIES).sort()).toEqual([...AI_TASK_NAMES].sort());
		for (const task of AI_TASK_NAMES) expect(taskPolicy(task).task).toBe(task);
		expect(Object.isFrozen(TASK_POLICIES)).toBe(true);
		expect(Object.isFrozen(taskPolicy('mail.draft'))).toBe(true);
	});

	it.each(Object.entries(TODAY))('routes %s as it is routed today', (feature, [task, tiers]) => {
		expect(taskForFeature(feature)).toBe(task);
		expect(taskPolicy(task).tiers).toEqual(tiers);
		expect(taskPolicy(task).plane).toBe('language');
	});

	it('maps every feature to one task only', () => {
		const seen = new Map<string, AiTaskName>();
		for (const entry of Object.values(TASK_POLICIES)) {
			for (const feature of entry.features) {
				expect(seen.get(feature), feature).toBeUndefined();
				seen.set(feature, entry.task);
			}
		}
	});

	it('keeps today’s attempt budgets and deadlines', () => {
		// Today's effective bounds: a one-shot request dies at the runtime's 300 s
		// header timeout, a tool loop or a stream at the 10-minute action limit.
		for (const task of ['mail.draft', 'mail.compose', 'assistant.answer'] as const) {
			expect(taskPolicy(task), task).toMatchObject({
				maxAttempts: MAX_LLM_ATTEMPTS,
				deadlineMs: 540_000,
			});
		}
		for (const task of ['mail.classify', 'mail.guard', 'embedding.index', 'plugin.invoke'] as const) {
			expect(taskPolicy(task), task).toMatchObject({
				maxAttempts: MAX_LLM_ATTEMPTS,
				deadlineMs: 300_000,
			});
		}
		// The decision plane keeps its adapters' own deadlines.
		expect(taskPolicy('mail.category').deadlineMs).toBeNull();
		expect(taskPolicy('mail.complete')).toMatchObject({
			maxAttempts: INTERACTIVE_LLM_ATTEMPTS,
			deadlineMs: INTERACTIVE_LLM_DEADLINE_MS.completion,
		});
		for (const task of ['mail.ask', 'mail.rewrite', 'mail.coach', 'mail.plan_coverage'] as const) {
			expect(taskPolicy(task), task).toMatchObject({
				maxAttempts: INTERACTIVE_LLM_ATTEMPTS,
				deadlineMs: INTERACTIVE_LLM_DEADLINE_MS.reply,
			});
		}
		expect(taskPolicy('knowledge.extract').deadlineMs).toBe(180_000);
		expect(taskPolicy('decision.connection_probe').maxAttempts).toBe(1);
	});

	it('limits nothing today except the plugin host’s output cap', () => {
		for (const entry of Object.values(TASK_POLICIES)) {
			expect(entry.maxInputTokens, entry.task).toBeNull();
			expect(entry.maxReasoningTokens, entry.task).toBeNull();
			if (entry.task !== 'plugin.invoke') expect(entry.maxOutputTokens, entry.task).toBeNull();
		}
		expect(taskPolicy('plugin.invoke').maxOutputTokens).toBe(PLUGIN_LLM_MAX_OUTPUT_TOKENS);
	});

	it('gives no task a paid fallback and no evaluation yet', () => {
		for (const entry of Object.values(TASK_POLICIES)) {
			expect(entry.fallback, entry.task).toBe('none');
			expect(entry.evalVersion, entry.task).toBe(0);
		}
	});

	it('draws guard, classify and the triage bundles from the triage allowance only', () => {
		const triage = Object.values(TASK_POLICIES)
			.filter((entry) => entry.budgetClass === 'triage')
			.map((entry) => entry.task)
			.sort();
		expect(triage).toEqual(
			['mail.category', 'mail.classify', 'mail.disposition', 'mail.guard', 'mail.triage'].sort()
		);
	});

	it('puts the decision bundles on the decision plane and embeddings on theirs', () => {
		for (const task of [
			'decision.connection_probe',
			'mail.triage',
			'mail.category',
			'mail.disposition',
			'mail.claim_check',
			'mail.necessity',
			'mail.draft_quality',
		] as const) {
			expect(taskPolicy(task), task).toMatchObject({ plane: 'decision', tiers: ['fast'] });
		}
		expect(taskPolicy('embedding.index').plane).toBe('embedding');
		expect(taskPolicy('embedding.query').plane).toBe('embedding');
	});
});

describe('taskForFeature', () => {
	it('knows plugin rows, task-named rows and the connection probe', () => {
		expect(taskForFeature('plugin:example')).toBe('plugin.invoke');
		expect(taskForFeature('mail.verify')).toBe('mail.verify');
		expect(taskForFeature(CONNECTION_PROBE_FEATURE)).toBe('decision.connection_probe');
	});

	it('answers undefined for a tag it does not know', () => {
		expect(taskForFeature('something_else')).toBeUndefined();
	});
});
