import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ParsedMail } from 'mailparser';

vi.mock('../../fblProcessor.js', () => ({
	tryParseARF: vi.fn(),
	isDuplicateComplaint: vi.fn(),
	generateDedupKey: vi.fn(() => 'dedup-key-xyz'),
}));
vi.mock('../../parser.js', () => ({
	parseBounce: vi.fn(),
}));
vi.mock('../../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseFblOrDsnPhase } from '../parseFblOrDsn.js';
import { tryParseARF, isDuplicateComplaint } from '../../fblProcessor.js';
import { parseBounce } from '../../parser.js';
import type { BasePhaseCtx, PhaseDeps } from '../../types.js';

function makeCtx(): BasePhaseCtx {
	return {
		parsed: { messageId: 'orig-1' } as unknown as ParsedMail,
		rawBuffer: Buffer.alloc(0),
		rcptTo: 'bounce+abc@bounces.owlat.com',
	};
}

const deps: PhaseDeps = { redis: {} as never, config: {} as never };

beforeEach(() => vi.clearAllMocks());

describe('parseFblOrDsnPhase — FBL/ARF', () => {
	it('bounceTo(fbl) when ARF parses and is not a duplicate', async () => {
		const arf = {
			type: 'complained' as const,
			bounceType: 'hard' as const,
			message: 'Spam complaint via ARF from microsoft',
			originalMessageId: 'orig-1',
			organizationId: 'org-1',
		};
		vi.mocked(tryParseARF).mockReturnValueOnce(arf);
		vi.mocked(isDuplicateComplaint).mockResolvedValueOnce(false);

		const out = await parseFblOrDsnPhase.run(deps, makeCtx());
		expect(out).toEqual({ kind: 'bounceTo', attempt: { kind: 'fbl', arf } });
		expect(parseBounce).not.toHaveBeenCalled();
	});

	it('dropSilently when ARF is a duplicate complaint', async () => {
		vi.mocked(tryParseARF).mockReturnValueOnce({
			type: 'complained',
			bounceType: 'hard',
			message: 'x',
			originalMessageId: 'orig-1',
		});
		vi.mocked(isDuplicateComplaint).mockResolvedValueOnce(true);

		const out = await parseFblOrDsnPhase.run(deps, makeCtx());
		expect(out).toEqual({ kind: 'dropSilently', reason: 'duplicate_fbl_complaint' });
		expect(parseBounce).not.toHaveBeenCalled();
	});
});

describe('parseFblOrDsnPhase — DSN', () => {
	it('bounceTo(dsn_attributed) when bounce parses with an originalMessageId', async () => {
		vi.mocked(tryParseARF).mockReturnValueOnce(null);
		const bounce = {
			type: 'bounced' as const,
			bounceType: 'hard' as const,
			message: 'mailbox unavailable',
			originalMessageId: 'orig-1',
			organizationId: 'org-1',
		};
		vi.mocked(parseBounce).mockReturnValueOnce(bounce);

		const out = await parseFblOrDsnPhase.run(deps, makeCtx());
		expect(out).toEqual({ kind: 'bounceTo', attempt: { kind: 'dsn_attributed', bounce } });
	});

	it('bounceTo(dsn_unattributed) when bounce parses without an originalMessageId', async () => {
		vi.mocked(tryParseARF).mockReturnValueOnce(null);
		vi.mocked(parseBounce).mockReturnValueOnce({
			type: 'bounced',
			bounceType: 'hard',
			message: 'unattributed',
		});

		const out = await parseFblOrDsnPhase.run(deps, makeCtx());
		expect(out).toEqual({ kind: 'bounceTo', attempt: { kind: 'dsn_unattributed' } });
	});
});

describe('parseFblOrDsnPhase — fallthrough', () => {
	it('continues when neither ARF nor DSN matches AND the rcpt is not a bounce envelope', async () => {
		vi.mocked(tryParseARF).mockReturnValueOnce(null);
		vi.mocked(parseBounce).mockReturnValueOnce(null);

		// A non-`bounce+` recipient (ordinary inbound mail) defers to routing.
		const ctx: BasePhaseCtx = {
			parsed: { messageId: 'orig-1' } as unknown as ParsedMail,
			rawBuffer: Buffer.alloc(0),
			rcptTo: 'someone@inbox.owlat.com',
		};
		const out = await parseFblOrDsnPhase.run(deps, ctx);
		expect(out).toEqual({ kind: 'continue', ctx });
	});

	// PR-74 (4): a DSN that landed on our `bounce+…` VERP envelope but could not
	// be attributed (parseBounce → null) MUST surface as `dsn_unattributed` so the
	// unattributed-bounce metric fires — not be silently routed to `unrecognized`.
	it('bounceTo(dsn_unattributed) for an unattributable DSN addressed to a bounce+ envelope', async () => {
		vi.mocked(tryParseARF).mockReturnValueOnce(null);
		vi.mocked(parseBounce).mockReturnValueOnce(null);

		const out = await parseFblOrDsnPhase.run(deps, makeCtx()); // rcptTo = bounce+abc@…
		expect(out).toEqual({ kind: 'bounceTo', attempt: { kind: 'dsn_unattributed' } });
	});
});
