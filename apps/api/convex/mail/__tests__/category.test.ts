/**
 * Pure-helper coverage for the smart-inbox classifier (mail/category.ts):
 * the deterministic `classifyMailCategory` and the `resolveCategory`
 * override-precedence rule.
 */
import { describe, it, expect } from 'vitest';
import {
	classifyMailCategory,
	resolveCategory,
	type MailCategoryInput,
} from '../category';

function input(overrides: Partial<MailCategoryInput> = {}): MailCategoryInput {
	return {
		fromAddress: 'alice@example.com',
		subject: 'Lunch on Friday?',
		hasListUnsubscribe: false,
		isKnownCorrespondent: false,
		...overrides,
	};
}

describe('classifyMailCategory', () => {
	it('classifies mail with a List-Unsubscribe header as newsletter', () => {
		expect(classifyMailCategory(input({ hasListUnsubscribe: true }))).toBe('newsletter');
	});

	it('classifies Precedence: bulk mail as newsletter', () => {
		expect(classifyMailCategory(input({ precedence: 'bulk' }))).toBe('newsletter');
		expect(classifyMailCategory(input({ precedence: 'List' }))).toBe('newsletter');
	});

	it('classifies a known human correspondent as person', () => {
		expect(classifyMailCategory(input({ isKnownCorrespondent: true }))).toBe('person');
	});

	it('classifies an order confirmation as receipt', () => {
		expect(
			classifyMailCategory(
				input({
					fromAddress: 'no-reply@shop.example.com',
					subject: 'Your order confirmation #10432',
				}),
			),
		).toBe('receipt');
	});

	it('receipt keywords win over a no-reply notification sender', () => {
		// Order confirmations routinely ship from no-reply@ — receipt must win.
		expect(
			classifyMailCategory(
				input({ fromAddress: 'no-reply@stripe.com', subject: 'Payment received' }),
			),
		).toBe('receipt');
	});

	it('classifies automated/no-reply senders as notification', () => {
		expect(
			classifyMailCategory(input({ fromAddress: 'notifications@github.com' })),
		).toBe('notification');
		expect(
			classifyMailCategory(input({ fromAddress: 'no-reply@service.example.com' })),
		).toBe('notification');
	});

	it('returns null for genuinely ambiguous mail (defer to the LLM)', () => {
		expect(
			classifyMailCategory(
				input({ fromAddress: 'jordan@startup.io', subject: 'Following up' }),
			),
		).toBeNull();
	});

	it('a known correspondent never overrides an explicit bulk signal', () => {
		expect(
			classifyMailCategory(
				input({ hasListUnsubscribe: true, isKnownCorrespondent: true }),
			),
		).toBe('newsletter');
	});
});

describe('resolveCategory', () => {
	it('a user override beats the LLM label', () => {
		expect(resolveCategory({ override: 'person', llm: 'newsletter' })).toEqual({
			label: 'person',
			source: 'user',
		});
	});

	it('a user override beats the deterministic label', () => {
		expect(resolveCategory({ override: 'receipt', deterministic: 'notification' })).toEqual({
			label: 'receipt',
			source: 'user',
		});
	});

	it('the LLM label beats the deterministic label when no override', () => {
		expect(resolveCategory({ llm: 'person', deterministic: 'other' })).toEqual({
			label: 'person',
			source: 'llm',
		});
	});

	it('falls back to the deterministic label, then to other', () => {
		expect(resolveCategory({ deterministic: 'newsletter' })).toEqual({
			label: 'newsletter',
			source: 'heuristic',
		});
		expect(resolveCategory({})).toEqual({ label: 'other', source: 'heuristic' });
	});
});
