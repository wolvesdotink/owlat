/**
 * Pure-function tests for `classifyStep.route` and the response-disposition
 * rules (ADR-0061) — covers every branch per ADR-0014's drift bug #2.
 */

import { describe, it, expect } from 'vitest';
import {
	classifyStep,
	buildClassifyPrompt,
	resolveResponseDisposition,
	sanitizeSummaries,
	toPersistedClassification,
	INFORMATIONAL_MIN_CONFIDENCE,
	type ClassifyOutput,
} from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_test' as Id<'inboundMessages'>;
const runCtx = { inboundMessageId: messageId, agentConfig: null };

function makeOutput(over: Partial<ClassifyOutput> = {}): ClassifyOutput {
	return {
		category: over.category ?? 'support',
		priority: over.priority ?? 'normal',
		sentiment: over.sentiment ?? 'neutral',
		intent: over.intent ?? 'question',
		confidence: over.confidence ?? 0.9,
		kind: over.kind ?? 'personal',
		needsResponse: over.needsResponse ?? true,
		language: over.language ?? 'en',
		importance: over.importance ?? 0.5,
		summary: over.summary ?? { en: 'Asks about billing.', de: 'Fragt zur Abrechnung.' },
		...(over.handlingRuleArchive !== undefined
			? { handlingRuleArchive: over.handlingRuleArchive }
			: {}),
	};
}

const sampleInput = {
	inboundMessageId: messageId,
	context: '[CONTEXT]',
};

describe('classifyStep.route', () => {
	it('archives spam classifications', () => {
		const route = classifyStep.route(makeOutput({ category: 'spam' }), sampleInput, runCtx);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('archived');
		if (route.transition.to !== 'archived') return;
		expect(route.transition.reason).toBe('classifier_spam');
	});

	it('archives on a matching auto_archive handling rule', () => {
		const route = classifyStep.route(
			makeOutput({ handlingRuleArchive: true, needsResponse: false, intent: 'information' }),
			sampleInput,
			runCtx
		);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('archived');
	});

	it('forks complaints through the clarify step (in-state, not straight to draft_ready)', () => {
		const output = makeOutput({ category: 'complaint' });
		const route = classifyStep.route(output, sampleInput, runCtx);
		expect(route.kind).toBe('in_state');
		if (route.kind !== 'in_state') return;
		expect(route.nextStep).toEqual({
			kind: 'clarify',
			input: {
				inboundMessageId: messageId,
				context: '[CONTEXT]',
				classification: toPersistedClassification(output),
			},
		});
	});

	it('forks urgent messages through the clarify step (in-state)', () => {
		const output = makeOutput({ priority: 'urgent' });
		const route = classifyStep.route(output, sampleInput, runCtx);
		expect(route.kind).toBe('in_state');
		if (route.kind !== 'in_state') return;
		expect(route.nextStep?.kind).toBe('clarify');
	});

	it('routes normal traffic to the clarify step (in-state) before drafting', () => {
		const output = makeOutput({ category: 'support', priority: 'normal' });
		const route = classifyStep.route(output, sampleInput, runCtx);
		expect(route.kind).toBe('in_state');
		if (route.kind !== 'in_state') return;
		expect(route.nextStep?.kind).toBe('clarify');
	});

	it('parks a confident no-response verdict as informational with the classification', () => {
		const output = makeOutput({ needsResponse: false, intent: 'information', language: 'de' });
		const route = classifyStep.route(output, sampleInput, runCtx);
		expect(route.kind).toBe('transition');
		if (route.kind !== 'transition') return;
		expect(route.transition.to).toBe('informational');
		if (route.transition.to !== 'informational') return;
		expect(route.transition.classification).toEqual({
			category: 'support',
			priority: 'normal',
			sentiment: 'neutral',
			intent: 'information',
			confidence: 0.9,
			needsResponse: false,
			kind: 'personal',
			language: 'de',
			importance: 0.5,
			summary: { en: 'Asks about billing.', de: 'Fragt zur Abrechnung.' },
		});
	});

	it('threads language and response signals into the clarify input', () => {
		const output = makeOutput({ language: 'fr', importance: 0.8 });
		const route = classifyStep.route(output, sampleInput, runCtx);
		if (route.kind !== 'in_state') throw new Error('expected in_state');
		const input = route.nextStep.input as { classification: Record<string, unknown> };
		expect(input.classification['language']).toBe('fr');
		expect(input.classification['needsResponse']).toBe(true);
		expect(input.classification['importance']).toBe(0.8);
	});
});

describe('resolveResponseDisposition', () => {
	const informational = {
		category: 'other',
		priority: 'normal',
		intent: 'information',
		confidence: 0.9,
		needsResponse: false,
	};

	it('is informational only for a confident, non-critical, informational-intent verdict', () => {
		expect(resolveResponseDisposition(informational)).toBe('informational');
		expect(resolveResponseDisposition({ ...informational, intent: 'acknowledgment' })).toBe(
			'informational'
		);
	});

	it('takes the reply path when the sender expects a response or the field is absent', () => {
		expect(resolveResponseDisposition({ ...informational, needsResponse: true })).toBe('reply');
		expect(resolveResponseDisposition({ ...informational, needsResponse: undefined })).toBe(
			'reply'
		);
	});

	it('never trusts a low-confidence no-response verdict', () => {
		expect(
			resolveResponseDisposition({
				...informational,
				confidence: INFORMATIONAL_MIN_CONFIDENCE - 0.01,
			})
		).toBe('reply');
		expect(
			resolveResponseDisposition({ ...informational, confidence: INFORMATIONAL_MIN_CONFIDENCE })
		).toBe('informational');
	});

	it('keeps complaints, urgent mail and escalations on the reply path whatever the boolean says', () => {
		expect(resolveResponseDisposition({ ...informational, category: 'complaint' })).toBe('reply');
		expect(resolveResponseDisposition({ ...informational, priority: 'urgent' })).toBe('reply');
		expect(resolveResponseDisposition({ ...informational, intent: 'escalation' })).toBe('reply');
	});

	it('files bulk kinds as informational whatever the intent label says', () => {
		expect(
			resolveResponseDisposition({ ...informational, intent: 'request', kind: 'advertising' })
		).toBe('informational');
		expect(
			resolveResponseDisposition({ ...informational, intent: 'question', kind: 'receipt' })
		).toBe('informational');
		// ...but never past the safety rails or a "needs a response" verdict.
		expect(
			resolveResponseDisposition({ ...informational, kind: 'newsletter', needsResponse: true })
		).toBe('reply');
		expect(
			resolveResponseDisposition({ ...informational, kind: 'advertising', priority: 'urgent' })
		).toBe('reply');
	});

	it('treats a question or request as needing a reply even when flagged informational', () => {
		expect(resolveResponseDisposition({ ...informational, intent: 'question' })).toBe('reply');
		expect(resolveResponseDisposition({ ...informational, intent: 'request' })).toBe('reply');
	});
});

describe('buildClassifyPrompt', () => {
	it('frames the context as untrusted data and asks for every shipped locale', () => {
		const prompt = buildClassifyPrompt('INBOUND-XYZ', ['en', 'de']);
		expect(prompt).toMatch(/untrusted DATA/i);
		expect(prompt).toContain('<untrusted_email_content>\nINBOUND-XYZ\n</untrusted_email_content>');
		expect(prompt).toContain('needsResponse');
		expect(prompt).toContain('ISO 639-1');
		expect(prompt).toContain('en, de');
	});
});

describe('sanitizeSummaries', () => {
	it('keeps only shipped locales, bounded and scrubbed', () => {
		const out = sanitizeSummaries({
			en: '  Supplier moved the delivery to Friday.\u0007 ',
			de: 'x'.repeat(400),
			fr: 'ignored',
			es: 42,
		});
		expect(out?.['en']).toBe('Supplier moved the delivery to Friday.');
		expect(out?.['de']?.length).toBe(240);
		expect(out?.['de']?.endsWith('…')).toBe(true);
		expect(out && 'fr' in out).toBe(false);
	});

	it('returns undefined when nothing usable came back', () => {
		expect(sanitizeSummaries(undefined)).toBeUndefined();
		expect(sanitizeSummaries({ en: '   ' })).toBeUndefined();
	});
});

describe('toPersistedClassification', () => {
	it('drops empty optionals so old-shape consumers see the five classic fields', () => {
		const persisted = toPersistedClassification(
			makeOutput({ language: '', summary: { en: '  ', de: '' } })
		);
		expect(persisted).toEqual({
			category: 'support',
			priority: 'normal',
			sentiment: 'neutral',
			intent: 'question',
			confidence: 0.9,
			needsResponse: true,
			kind: 'personal',
			importance: 0.5,
		});
	});
});
