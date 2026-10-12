/**
 * L6, attachment gates (`deliveryPipeline/captureGate.ts`): which messages the
 * switch keeps out of the file library, and that `planCapture` reports it
 * before any staging. The Team Inbox route, the switch's default and the row
 * marker are covered in `inbox/__tests__/inboundIngest.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
	attachmentGateSkip,
	mailboxGateSignals,
	resolveAttachmentGate,
} from '../deliveryPipeline/captureGate';
import { resolveRoutingPolicy } from '@owlat/shared/aiRouting';
import { planCapture } from '../deliveryPipeline/capture';
import { NOTHING_UNCLEARED } from '../deliveryPipeline/attachmentParts';
import { NO_HEADER_EVIDENCE, headerEvidenceFromMap } from '../../lib/mailEvidence';

describe('attachmentGateSkip', () => {
	it('keeps out Spam, a spam or quarantine verdict, and automated mail', () => {
		expect(attachmentGateSkip({ folderRole: 'spam', headers: NO_HEADER_EVIDENCE })).toBe('spam');
		expect(attachmentGateSkip({ folderRole: 'junk', headers: NO_HEADER_EVIDENCE })).toBe('spam');
		expect(attachmentGateSkip({ spamVerdict: 'quarantine', headers: NO_HEADER_EVIDENCE })).toBe(
			'spam'
		);
		expect(
			attachmentGateSkip({ headers: headerEvidenceFromMap({ 'auto-submitted': 'auto-generated' }) })
		).toBe('automated');
		expect(attachmentGateSkip({ headers: headerEvidenceFromMap({ precedence: 'bulk' }) })).toBe(
			'automated'
		);
		expect(
			attachmentGateSkip({ headers: headerEvidenceFromMap({}, { hasListUnsubscribe: true }) })
		).toBe('automated');
	});

	it('lets a person through: inbox, ham, forwarded by another Owlat mailbox', () => {
		expect(
			attachmentGateSkip({
				folderRole: 'inbox',
				spamVerdict: 'ham',
				headers: headerEvidenceFromMap({ 'x-owlat-forwarded': 'mbx_1', precedence: 'first-class' }),
			})
		).toBeNull();
	});

	it('builds the Postbox signals from the settled routing and the ingest headers', () => {
		expect(
			mailboxGateSignals(
				{ folderRole: 'archive', spamVerdict: 'ham' },
				{ antiLoopHeaders: { 'list-id': '<l>' }, unsubscribe: { mailto: 'x@y' } }
			)
		).toEqual({
			folderRole: 'archive',
			spamVerdict: 'ham',
			headers: { listId: '<l>', hasListUnsubscribe: true },
		});
	});
});

describe('planCapture with a gate', () => {
	const part = {
		filename: 'notes.txt',
		contentType: 'text/plain',
		bytes: new Uint8Array(10),
		disposition: 'attachment' as const,
	};
	const input = {
		parts: [part],
		withheld: NOTHING_UNCLEARED,
		messageId: '<m@x>',
		from: 'Bob <bob@example.com>',
		auth: {},
	};

	it('reports the gate and stages nothing', () => {
		expect(planCapture({ ...input, gateSkip: 'automated' })).toEqual({
			outcome: { indexed: 0, skippedReason: 'automated' },
		});
	});

	it('without a gate plans the capture as before', () => {
		const plan = planCapture({ ...input, gateSkip: null });
		expect('eligible' in plan ? plan.eligible : null).toEqual([part]);
	});

	it('a message with nothing to capture reports nothing, gate or not', () => {
		expect(planCapture({ ...input, parts: [], gateSkip: 'spam' })).toEqual({
			outcome: { indexed: 0 },
		});
	});
});

describe('resolveAttachmentGate', () => {
	const listMail = { headers: headerEvidenceFromMap({ 'list-id': '<l>' }) };
	const ctxWith = (policy: unknown) =>
		({ runQuery: async () => policy }) as unknown as Parameters<typeof resolveAttachmentGate>[0];

	it('is off by default, and off when the policy cannot be read', async () => {
		expect(await resolveAttachmentGate(ctxWith(resolveRoutingPolicy(null)), listMail)).toBeNull();
		const failing = {
			runQuery: async () => {
				throw new Error('down');
			},
		} as unknown as Parameters<typeof resolveAttachmentGate>[0];
		expect(await resolveAttachmentGate(failing, listMail)).toBeNull();
	});

	it('applies the gate when the switch is on', async () => {
		const policy = resolveRoutingPolicy({ attachmentGates: 'enforce' });
		expect(await resolveAttachmentGate(ctxWith(policy), listMail)).toBe('automated');
	});
});
