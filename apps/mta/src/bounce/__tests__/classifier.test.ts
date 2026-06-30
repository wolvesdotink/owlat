import { describe, expect, it, vi } from 'vitest';
import { classifyBounce } from '../classifier.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('classifyBounce', () => {
	describe('ARF complaints', () => {
		it('detects feedback-report as complaint', () => {
			const result = classifyBounce('This is a feedback-report from the ISP');
			expect(result.type).toBe('complained');
			expect(result.bounceType).toBe('hard');
		});

		it('detects feedback-type: abuse as complaint', () => {
			const result = classifyBounce('feedback-type: abuse\nreported-domain: example.com');
			expect(result.type).toBe('complained');
			expect(result.bounceType).toBe('hard');
		});
	});

	describe('enhanced status codes', () => {
		it('classifies 5.1.1 as hard bounce', () => {
			const result = classifyBounce('550 5.1.1 User not found');
			expect(result.bounceType).toBe('hard');
			expect(result.diagnosticCode).toBeDefined();
		});

		it('classifies 5.2.2 (mailbox full) as soft bounce', () => {
			const result = classifyBounce('552 5.2.2 Mailbox full');
			expect(result.bounceType).toBe('soft');
		});

		it('classifies 5.7.1 as hard bounce', () => {
			const result = classifyBounce('550 5.7.1 Message rejected');
			expect(result.bounceType).toBe('hard');
		});

		it('classifies 4.2.1 as soft bounce', () => {
			const result = classifyBounce('450 4.2.1 Mailbox temporarily unavailable');
			expect(result.bounceType).toBe('soft');
		});
	});

	describe('structured RFC 3464 DSN fields (§2.3)', () => {
		// A minimal standards DSN whose only enhanced code lives in the
		// machine-readable message/delivery-status part — the human-readable text
		// carries no code. The free-text regex alone would default this to soft.
		it('classifies a Status: 5.1.1 + Action: failed delivery-status part as hard', () => {
			const deliveryStatus = [
				'Reporting-MTA: dns; mx.example.com',
				'',
				'Final-Recipient: rfc822; user@example.com',
				'Action: failed',
				'Status: 5.1.1',
			].join('\n');
			// No enhanced code in the human-readable prose.
			const body = `Your message could not be delivered.\n${deliveryStatus}`;

			const result = classifyBounce(body);
			expect(result.bounceType).toBe('hard');
			expect(result.diagnosticCode).toBe('5.1.1');
		});

		it('classifies a Status: 4.2.1 delivery-status part as soft', () => {
			const deliveryStatus = [
				'Reporting-MTA: dns; mx.example.com',
				'',
				'Final-Recipient: rfc822; user@example.com',
				'Action: delayed',
				'Status: 4.2.1',
			].join('\n');
			const body = `Your message is delayed.\n${deliveryStatus}`;

			const result = classifyBounce(body);
			expect(result.bounceType).toBe('soft');
			expect(result.diagnosticCode).toBe('4.2.1');
		});

		it('treats the structured Status: field over a stray number elsewhere in the body', () => {
			// Prose mentions a "5.1.1" lookalike that is part of an unrelated id,
			// but the authoritative Status: field is a temporary 4.x code.
			const deliveryStatus = [
				'Final-Recipient: rfc822; user@example.com',
				'Action: delayed',
				'Status: 4.7.1',
			].join('\n');
			const body = `Reference 4.5.1.1 in queue.\n${deliveryStatus}`;

			const result = classifyBounce(body);
			expect(result.bounceType).toBe('soft');
			expect(result.diagnosticCode).toBe('4.7.1');
		});

		it('treats an explicit Action: failed with no Status: code as hard', () => {
			const deliveryStatus = [
				'Final-Recipient: rfc822; user@example.com',
				'Action: failed',
				'Diagnostic-Code: smtp; 550 Requested action not taken',
			].join('\n');
			const body = `Delivery problem.\n${deliveryStatus}`;

			const result = classifyBounce(body);
			expect(result.bounceType).toBe('hard');
		});
	});

	describe('pattern matching', () => {
		it('detects "user unknown" as hard bounce', () => {
			const result = classifyBounce('user unknown at this domain');
			expect(result.bounceType).toBe('hard');
		});

		it('detects "mailbox full" as soft bounce', () => {
			const result = classifyBounce('mailbox full, try again later');
			expect(result.bounceType).toBe('soft');
		});

		it('detects "greylisted" as soft bounce', () => {
			const result = classifyBounce('Message greylisted, please retry');
			expect(result.bounceType).toBe('soft');
		});

		it('when both hard and soft patterns are present, soft wins', () => {
			const result = classifyBounce('user unknown but also mailbox full');
			expect(result.bounceType).toBe('soft');
		});
	});

	// ── PR-72 regression-lock: RFC 3463 enhanced-status-code class mapping ──
	//
	// Locks the class→disposition table classifyByEnhancedCode encodes:
	//   5.1.1 → hard (address)        5.2.2 → soft (mailbox-full exception)
	//   5.7.1 → hard (policy)         4.2.x → soft (transient class-4)
	//   class 2 (success codes)       → falls through (no 4/5 branch) → default soft
	// A standards DSN may carry only the machine-readable `Status:` code, so each
	// case is asserted both inline-in-prose AND in a structured delivery-status
	// part. If a future edit drops the 5.2.2 exception or routes class-4 to hard,
	// these fail. See EMAIL_BEST_PRACTICES_AUDIT_2026-06-21.md "PR-72".
	describe('RFC 3463 class mapping table (PR-72 regression-lock)', () => {
		const cases: ReadonlyArray<{ code: string; bounceType: 'hard' | 'soft' }> = [
			{ code: '5.1.1', bounceType: 'hard' }, // permanent address
			{ code: '5.2.2', bounceType: 'soft' }, // mailbox full — soft despite 5xx
			{ code: '5.7.1', bounceType: 'hard' }, // permanent policy/security
			{ code: '4.2.0', bounceType: 'soft' }, // transient class-4
			{ code: '4.2.2', bounceType: 'soft' }, // transient class-4
		];

		it.each(cases)('inline prose code $code → $bounceType', ({ code, bounceType }) => {
			const result = classifyBounce(`Delivery status ${code} reported`);
			expect(result.bounceType).toBe(bounceType);
			expect(result.type).toBe('bounced');
		});

		it.each(cases)('structured Status: $code → $bounceType', ({ code, bounceType }) => {
			const deliveryStatus = [
				'Final-Recipient: rfc822; user@example.com',
				`Action: ${code.startsWith('4') ? 'delayed' : 'failed'}`,
				`Status: ${code}`,
			].join('\n');
			const result = classifyBounce(`Report.\n${deliveryStatus}`);
			expect(result.bounceType).toBe(bounceType);
			expect(result.diagnosticCode).toBe(code);
		});

		it('a class-2 (success) enhanced code falls through to the soft default', () => {
			// classifyByEnhancedCode has no class-2 branch, so a 2.x.x code is not a
			// classification — the engine falls through to the free-text heuristic,
			// which has no matching pattern and defaults to soft (never auto-hard).
			const result = classifyBounce('250 2.0.0 message accepted');
			expect(result.type).toBe('bounced');
			expect(result.bounceType).toBe('soft');
		});

		it('a structured Status: 2.x.x part also falls through to soft (class-2 not permanent)', () => {
			const deliveryStatus = [
				'Final-Recipient: rfc822; user@example.com',
				'Action: relayed',
				'Status: 2.1.5',
			].join('\n');
			const result = classifyBounce(`Relayed.\n${deliveryStatus}`);
			expect(result.bounceType).toBe('soft');
		});
	});

	describe('defaults and edge cases', () => {
		it('defaults to soft bounce when no patterns match', () => {
			const result = classifyBounce('some generic error occurred');
			expect(result.bounceType).toBe('soft');
		});

		it('truncates messages longer than 500 characters', () => {
			const longBody = 'x'.repeat(600);
			const result = classifyBounce(longBody);
			expect(result.message).toBeDefined();
			expect(result.message!.length).toBeLessThanOrEqual(503); // 500 + '...'
			expect(result.message!.endsWith('...')).toBe(true);
		});

		it('uses subject for pattern detection', () => {
			const result = classifyBounce('no useful content here', 'user unknown');
			expect(result.bounceType).toBe('hard');
		});
	});
});
