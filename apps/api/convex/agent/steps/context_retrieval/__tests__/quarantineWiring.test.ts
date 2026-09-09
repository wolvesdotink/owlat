/**
 * `contextRetrievalStep.execute` renders the [CURRENT MESSAGE] briefing from the
 * quarantined STRUCTURED extraction (facts + questions) instead of the raw
 * sender prose, so the draft/clarify steps consume the structured form:
 *   - extraction available  -> [CURRENT MESSAGE] carries the structured block and
 *     NOT the raw body sentinel.
 *   - extraction unavailable -> FAIL SOFT to the hidden-stripped raw body.
 *
 * Convex query/action/mutation seams are mocked — no live backend.
 */

import { describe, it, expect } from 'vitest';
import { makeStepCtx } from '../../__tests__/stepCtx';
import { contextRetrievalStep } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_quarantine' as Id<'inboundMessages'>;
const input = { inboundMessageId: messageId };

const RAW_BODY = 'RAWBODYSENTINEL please tell me where order 4821 is';
const STRUCTURED =
	'[SENDER FACTS]\n- Order 4821 was placed\n\n[SENDER QUESTIONS / REQUESTS]\n- Where is order 4821?';

/** ctx serving one contact-less/thread-less inbound; retrieval legs empty. */
function makeCtx(extractResult: string | null) {
	const message = {
		from: 'sender@example.com',
		to: 'me@hl.camp',
		subject: 'Order status',
		textBody: RAW_BODY,
		receivedAt: Date.now(),
	};

	return makeStepCtx<Parameters<typeof contextRetrievalStep.execute>[0]>({
		queries: {
			getMessage: message,
			getContact: null,
			getRecentActivities: [],
			getThreadMessages: [],
			getOpenCommitments: [],
			isGraphRetrievalEnabled: false,
		},
		actions: { quarantine: extractResult, knowledge: [], semanticFileProcessing: [] },
		mutations: { recordContextTier: null },
	});
}

describe('contextRetrievalStep.execute — quarantined structured current message', () => {
	it('renders the structured extraction and never the raw body when extraction succeeds', async () => {
		const { output } = await contextRetrievalStep.execute(makeCtx(STRUCTURED), input);
		expect(output.context).toContain('[CURRENT MESSAGE]');
		expect(output.context).toContain('[SENDER FACTS]');
		expect(output.context).toContain('Where is order 4821?');
		// The raw prose never sits in the briefing.
		expect(output.context).not.toContain('RAWBODYSENTINEL');
	});

	it('falls back to the raw body when extraction is unavailable (fail soft)', async () => {
		const { output } = await contextRetrievalStep.execute(makeCtx(null), input);
		expect(output.context).toContain('[CURRENT MESSAGE]');
		expect(output.context).toContain('RAWBODYSENTINEL');
	});
});
