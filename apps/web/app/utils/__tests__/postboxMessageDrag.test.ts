import { describe, it, expect } from 'vitest';
import { acceptsMessageDrop, dragMessageIds } from '../postboxMessageDrag';

describe('dragMessageIds', () => {
	it('drags the whole selection, in selection order, when the grabbed row is in it', () => {
		expect(dragMessageIds('b', ['c', 'b', 'a'])).toEqual(['c', 'b', 'a']);
	});

	it('drags the grabbed row alone when it is not selected', () => {
		expect(dragMessageIds('x', ['a', 'b'])).toEqual(['x']);
		expect(dragMessageIds('x', [])).toEqual(['x']);
	});
});

describe('acceptsMessageDrop', () => {
	const fromInbox = { mailboxId: 'mbx-1', sourceFolder: 'inbox' };

	it('accepts system and custom destinations in the same mailbox', () => {
		expect(acceptsMessageDrop({ _id: 'f-arch', role: 'archive' }, fromInbox, 'mbx-1')).toBe(true);
		expect(acceptsMessageDrop({ _id: 'f-trash', role: 'trash' }, fromInbox, 'mbx-1')).toBe(true);
		expect(acceptsMessageDrop({ _id: 'f-clients' }, fromInbox, 'mbx-1')).toBe(true);
	});

	it('never files into Sent or Drafts', () => {
		expect(acceptsMessageDrop({ _id: 'f-sent', role: 'sent' }, fromInbox, 'mbx-1')).toBe(false);
		expect(acceptsMessageDrop({ _id: 'f-dr', role: 'drafts' }, fromInbox, 'mbx-1')).toBe(false);
	});

	it('refuses the folder the rows came from, by role or by custom-folder id', () => {
		expect(acceptsMessageDrop({ _id: 'f-in', role: 'inbox' }, fromInbox, 'mbx-1')).toBe(false);
		const fromCustom = { mailboxId: 'mbx-1', sourceFolder: 'f-clients' };
		expect(acceptsMessageDrop({ _id: 'f-clients' }, fromCustom, 'mbx-1')).toBe(false);
		expect(acceptsMessageDrop({ _id: 'f-in', role: 'inbox' }, fromCustom, 'mbx-1')).toBe(true);
	});

	it('accepts every destination for a list that is not one folder (label, search)', () => {
		const fromLabel = { mailboxId: 'mbx-1', sourceFolder: null };
		expect(acceptsMessageDrop({ _id: 'f-in', role: 'inbox' }, fromLabel, 'mbx-1')).toBe(true);
	});

	it("refuses another mailbox's rail", () => {
		expect(acceptsMessageDrop({ _id: 'f-arch', role: 'archive' }, fromInbox, 'mbx-2')).toBe(false);
	});
});
