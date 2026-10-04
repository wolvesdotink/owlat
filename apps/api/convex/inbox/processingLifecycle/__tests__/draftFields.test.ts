import { describe, it, expect } from 'vitest';
import { reduce } from '../reducers';
import type { Doc, Id } from '../../../_generated/dataModel';

// The `→ draft_ready` reducer's draft fields (#1201): an agent draft that
// replaces a different text, and a reopen that drops the draft, both leave the
// saved-edit history of the old draft behind.

const savedEdits = {
	draftRevisions: [
		{ text: 'Old agent draft.', savedAt: 1, savedBy: 'agent' },
		{ text: 'A person’s edit.', savedAt: 2, savedBy: 'user-1' },
	],
	draftSavedAt: 2,
	isDraftEdited: true,
};

function message(overrides: Partial<Doc<'inboundMessages'>> = {}): Doc<'inboundMessages'> {
	return {
		_id: 'msg1' as Id<'inboundMessages'>,
		_creationTime: 0,
		messageId: 'ext-1',
		from: 'sender@example.com',
		to: 'support@owlat.app',
		subject: 'Help',
		textBody: 'I need help',
		processingStatus: 'drafting',
		receivedAt: 0,
		draftResponse: 'A person’s edit.',
		...savedEdits,
		...overrides,
	} as unknown as Doc<'inboundMessages'>;
}

const cleared = { draftRevisions: undefined, draftSavedAt: undefined, isDraftEdited: undefined };

describe('draft_ready reducer: saved edits', () => {
	it('clears them when the transition carries a new agent draft', () => {
		const { patch } = reduce(message(), {
			to: 'draft_ready',
			at: 10,
			draftResponse: 'A new agent draft.',
		});
		expect(patch).toMatchObject({ draftResponse: 'A new agent draft.', ...cleared });
		expect(patch).toHaveProperty('draftSavedAt');
	});

	it('keeps them when the carried draft is the text already shown', () => {
		const { patch } = reduce(message(), {
			to: 'draft_ready',
			at: 10,
			draftResponse: 'A person’s edit.',
		});
		expect(patch).not.toHaveProperty('draftRevisions');
		expect(patch).not.toHaveProperty('draftSavedAt');
		expect(patch).not.toHaveProperty('isDraftEdited');
	});

	it('keeps them on a hold for review that carries no draft', () => {
		const { patch } = reduce(message(), { to: 'draft_ready', at: 10 });
		expect(patch).not.toHaveProperty('draftSavedAt');
	});

	it('clears them when a rejected or archived message is reopened', () => {
		for (const processingStatus of ['rejected', 'archived'] as const) {
			const { patch } = reduce(message({ processingStatus }), {
				to: 'draft_ready',
				at: 10,
				manualTakeover: true,
			});
			expect(patch).toMatchObject({ draftResponse: undefined, ...cleared });
			expect(patch).toHaveProperty('draftSavedAt');
		}
	});

	it('keeps them when a person takes over a failed message, whose draft stays', () => {
		const { patch } = reduce(message({ processingStatus: 'failed' }), {
			to: 'draft_ready',
			at: 10,
			manualTakeover: true,
		});
		expect(patch).not.toHaveProperty('draftResponse');
		expect(patch).not.toHaveProperty('draftSavedAt');
	});
});
