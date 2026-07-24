import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../classifier.js', () => ({
	classifyBounce: vi.fn().mockReturnValue({
		type: 'bounced',
		bounceType: 'hard',
		message: '550 5.1.1 User unknown',
	}),
}));
vi.mock('../verp.js', () => ({
	parseVerpAddress: vi.fn().mockReturnValue(null),
	isVerpSigningEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { ParsedMessage, MessageAttachment } from '@owlat/mail-message';
import { parseBounce, getUnattributedBounceCount } from '../parser.js';
import { parseVerpAddress } from '../verp.js';
import { classifyBounce } from '../classifier.js';
import { logger } from '../../monitoring/logger.js';
import { parseFblOrDsnPhase } from '../phases/parseFblOrDsn.js';
import { reduce } from '../outcome.js';
import { reportPartsOf } from './helpers/reportParts.js';
import type { BasePhaseCtx, BounceAttempt, PhaseDeps } from '../types.js';

function createMockParsedMail(overrides: Record<string, unknown> = {}): ParsedMessage {
	return {
		text: '',
		subject: '',
		headers: new Map(),
		attachments: [],
		...overrides,
	} as unknown as ParsedMessage;
}

/** `parseBounce` with the report parts derived from the mock (see {@link reportPartsOf}). */
function pb(parsed: ParsedMessage, envelopeRcptTo?: string) {
	return parseBounce(parsed, reportPartsOf(parsed), envelopeRcptTo);
}

describe('parseBounce', () => {
	it('extracts messageId from VERP envelope recipient', () => {
		vi.mocked(parseVerpAddress).mockReturnValue('msg-001');

		const result = pb(createMockParsedMail(), 'bounce+bXNnLTAwMQ@bounces.owlat.com');

		expect(result).not.toBeNull();
		expect(result!.originalMessageId).toBe('msg-001');
		expect(parseVerpAddress).toHaveBeenCalledWith('bounce+bXNnLTAwMQ@bounces.owlat.com');
	});

	it('rejects X-Owlat-Message-Id in returned attachments without signed VERP', () => {
		vi.mocked(parseVerpAddress).mockReturnValue(null);

		const result = pb(
			createMockParsedMail({
				attachments: [
					{
						content: Buffer.from('X-Owlat-Message-Id: msg-from-attachment\r\nOther: header'),
					},
				],
			})
		);

		expect(result).toBeNull();
	});

	it('rejects X-Owlat-Message-Id in returned body text without signed VERP', () => {
		vi.mocked(parseVerpAddress).mockReturnValue(null);

		const result = pb(
			createMockParsedMail({
				text: 'Some bounce text\nX-Owlat-Message-Id: msg-from-body\nMore text',
				attachments: [],
			})
		);

		expect(result).toBeNull();
	});

	it('returns null when no messageId is extractable', () => {
		vi.mocked(parseVerpAddress).mockReturnValue(null);

		const result = pb(
			createMockParsedMail({
				text: 'Some bounce message with no useful headers',
				attachments: [],
			})
		);

		expect(result).toBeNull();
	});

	it('logs detailed context when bounce is unattributed', () => {
		vi.mocked(parseVerpAddress).mockReturnValue(null);

		pb(
			createMockParsedMail({
				text: 'Delivery failure for user@example.com',
				subject: 'Mail delivery failed',
				from: { text: 'mailer-daemon@mx.example.com' },
				attachments: [],
			}),
			'bounce+invalid@bounces.owlat.com'
		);

		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				subject: 'Mail delivery failed',
				envelopeRcptTo: 'bounce+invalid@bounces.owlat.com',
				hasAttachments: false,
				textPreview: expect.stringContaining('Delivery failure'),
			}),
			expect.stringContaining('Unattributed bounce')
		);
	});

	it('increments unattributed bounce counter on each failed extraction', () => {
		vi.mocked(parseVerpAddress).mockReturnValue(null);
		const countBefore = getUnattributedBounceCount();

		pb(createMockParsedMail({ text: 'No useful headers', attachments: [] }));
		pb(createMockParsedMail({ text: 'Another unattributed bounce', attachments: [] }));

		expect(getUnattributedBounceCount()).toBe(countBefore + 2);
	});

	it('extracts organizationId from X-Owlat-Org-Id', () => {
		vi.mocked(parseVerpAddress).mockReturnValue('msg-001');

		const result = pb(
			createMockParsedMail({
				text: 'X-Owlat-Org-Id: org-42\nSome bounce text',
			}),
			'bounce+bXNnLTAwMQ@bounces.owlat.com'
		);

		expect(result).not.toBeNull();
		expect(result!.organizationId).toBe('org-42');
	});

	it('delegates classification to classifyBounce', () => {
		vi.mocked(parseVerpAddress).mockReturnValue('msg-001');
		vi.mocked(classifyBounce).mockReturnValue({
			type: 'bounced',
			bounceType: 'soft',
			message: '450 4.2.1 Mailbox temporarily unavailable',
		});

		const result = pb(
			createMockParsedMail({ text: 'Mailbox temporarily unavailable' }),
			'bounce+bXNnLTAwMQ@bounces.owlat.com'
		);

		expect(result).not.toBeNull();
		expect(result!.bounceType).toBe('soft');
		expect(classifyBounce).toHaveBeenCalled();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// PR-74 (4): the unattributed-bounce path is observable end-to-end —
	// `parseBounce` increments the in-process counter AND logs, AND the
	// classify-phase + reducer emit the `unattributed_bounce` metric effect (the
	// `dsn_unattributed` metric) rather than silently routing the DSN away.
	// RFC 3464: a DSN may carry no recoverable original Message-ID; that feedback
	// must surface to monitoring, not vanish.
	// ─────────────────────────────────────────────────────────────────────────
	describe('unattributed-bounce observability (PR-74)', () => {
		const deps: PhaseDeps = { redis: {} as never, config: {} as never };

		function unattributableDsnCtx(): BasePhaseCtx {
			return {
				// A real bounce envelope (`bounce+…`) whose token does not decode
				// (parseVerpAddress is mocked → null) and which carries no usable
				// X-Owlat-Message-Id, so it is a genuine-but-unattributable DSN.
				parsed: createMockParsedMail({
					subject: 'Delivery Status Notification (Failure)',
					from: { text: 'MAILER-DAEMON@mx.remote.test' },
					text: 'Delivery to the following recipient failed permanently.',
					attachments: [],
				}),
				rawBuffer: Buffer.alloc(0),
				rcptTo: 'bounce+notavalidtoken@bounces.owlat.com',
			};
		}

		it('increments the counter AND logs when parseBounce cannot attribute', () => {
			vi.mocked(parseVerpAddress).mockReturnValue(null);
			const before = getUnattributedBounceCount();

			const ctx = unattributableDsnCtx();
			const result = pb(ctx.parsed, ctx.rcptTo);

			expect(result).toBeNull();
			expect(getUnattributedBounceCount()).toBe(before + 1);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					envelopeRcptTo: 'bounce+notavalidtoken@bounces.owlat.com',
					unattributedTotal: before + 1,
				}),
				expect.stringContaining('Unattributed bounce')
			);
		});

		it('classify-phase + reducer emit exactly the unattributed_bounce metric (dsn_unattributed)', async () => {
			vi.mocked(parseVerpAddress).mockReturnValue(null);
			const ctx = unattributableDsnCtx();

			const out = await parseFblOrDsnPhase.run(deps, ctx);
			expect(out.kind).toBe('bounceTo');
			const attempt = (out as { kind: 'bounceTo'; attempt: BounceAttempt }).attempt;
			expect(attempt.kind).toBe('dsn_unattributed');

			// The reducer turns that attempt into the single observability effect
			// that bumps `unattributedBouncesTotal` (the Prometheus DSN metric).
			const { effects } = reduce(attempt, ctx);
			expect(effects).toEqual([{ kind: 'metric_inc', metric: 'unattributed_bounce' }]);
		});
	});

	it('feeds the message/delivery-status MIME part to classifyBounce', () => {
		vi.mocked(parseVerpAddress).mockReturnValue('msg-001');
		vi.mocked(classifyBounce).mockReturnValue({
			type: 'bounced',
			bounceType: 'hard',
			message: '5.1.1',
		});

		pb(
			createMockParsedMail({
				// Human-readable text carries no enhanced code.
				text: 'Your message could not be delivered.',
				attachments: [
					{
						contentType: 'message/delivery-status',
						content: Buffer.from(
							'Final-Recipient: rfc822; user@example.com\r\nAction: failed\r\nStatus: 5.1.1'
						),
					},
				] as unknown as MessageAttachment[],
			}),
			'bounce+bXNnLTAwMQ@bounces.owlat.com'
		);

		expect(classifyBounce).toHaveBeenCalled();
		const bodyArg = vi.mocked(classifyBounce).mock.calls.at(-1)![0];
		expect(bodyArg).toContain('Status: 5.1.1');
		expect(bodyArg).toContain('Action: failed');
	});
});
