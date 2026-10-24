/**
 * The draft reducers are pure: the same draft, input and undo token give the
 * same result, and the inputs come back untouched. The undo token is minted
 * by the dispatcher and handed in; `scripts/check-purity.sh` keeps a random
 * source out of the reducer module itself.
 */

import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../../_generated/dataModel';
import { reduceDraftRevert, reducePendingSend, reduceScheduled } from '../reducers';
import { DEFAULT_UNDO_SEND_DELAY_MS } from '../types';

function draftFixture(): Doc<'mailDrafts'> {
	return {
		_id: 'draft_1' as Id<'mailDrafts'>,
		_creationTime: 1,
		mailboxId: 'mailbox_1' as Id<'mailboxes'>,
		state: 'draft',
		fromAddress: 'sender@owlat.example',
		toAddresses: ['Ada@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Hello',
		bodyHtml: '<p>Hi</p>',
		attachments: [],
		lastEditedAt: 1,
	} as unknown as Doc<'mailDrafts'>;
}

describe('draft reducers', () => {
	it('→ pending_send returns the same result for the same draft, input and token', () => {
		const draft = draftFixture();
		const input = { to: 'pending_send', at: 1_000 } as const;
		const before = structuredClone(draft);

		const first = reducePendingSend(draft, input, 'und_tok_a');
		const second = reducePendingSend(draft, input, 'und_tok_a');

		expect(second).toEqual(first);
		expect(draft).toEqual(before);
		expect(input).toEqual({ to: 'pending_send', at: 1_000 });
		expect(first.patch).toEqual({
			state: 'pending_send',
			scheduledSendAt: 1_000 + DEFAULT_UNDO_SEND_DELAY_MS,
			undoToken: 'und_tok_a',
			lastEditedAt: 1_000,
		});
		expect(first.extras).toEqual({
			undoToken: 'und_tok_a',
			sendAt: 1_000 + DEFAULT_UNDO_SEND_DELAY_MS,
		});
		expect(first.effects[0]).toEqual({
			kind: 'schedule_dispatch_action',
			draftId: draft._id,
			undoToken: 'und_tok_a',
			sendAt: 1_000 + DEFAULT_UNDO_SEND_DELAY_MS,
		});
	});

	it('→ scheduled carries the injected token to the patch, the dispatch and the caller', () => {
		const draft = draftFixture();
		const input = { to: 'scheduled', at: 1_000, scheduledSendAt: 90_000 } as const;
		const before = structuredClone(draft);

		const first = reduceScheduled(draft, input, 'und_tok_b');

		expect(reduceScheduled(draft, input, 'und_tok_b')).toEqual(first);
		expect(draft).toEqual(before);
		expect(first.patch.undoToken).toBe('und_tok_b');
		expect(first.extras).toEqual({ undoToken: 'und_tok_b', sendAt: 90_000 });
		expect(first.effects[0]).toMatchObject({
			kind: 'schedule_dispatch_action',
			undoToken: 'und_tok_b',
			sendAt: 90_000,
		});
	});

	it('a different token is the only difference between two holds of the same draft', () => {
		const draft = draftFixture();
		const input = { to: 'pending_send', at: 1_000, undoSendDelayMs: 5_000 } as const;

		const first = reducePendingSend(draft, input, 'und_tok_a');
		const second = reducePendingSend(draft, input, 'und_tok_c');

		expect(second.patch).toEqual({ ...first.patch, undoToken: 'und_tok_c' });
		expect(second.extras).toEqual({ ...first.extras, undoToken: 'und_tok_c' });
	});

	it('→ draft clears the token without needing one', () => {
		const draft = {
			...draftFixture(),
			state: 'pending_send',
			undoToken: 'und_tok_a',
		} as Doc<'mailDrafts'>;
		const input = { to: 'draft', at: 2_000, reason: 'user_cancel' } as const;

		const first = reduceDraftRevert(draft, input);

		expect(reduceDraftRevert(draft, input)).toEqual(first);
		expect(first.patch).toMatchObject({ state: 'draft', undoToken: undefined });
	});
});
