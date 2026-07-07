/**
 * usePostboxComposerStack: the popup stack bookkeeping plus the focus surface.
 * `useState` is stubbed with per-key buckets so each test starts from an empty
 * stack; every helper is exercised against the reactive state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stateBuckets: Map<string, any>;
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
	return stateBuckets.get(key);
});

import { usePostboxComposerStack } from '../usePostboxComposerStack';

const MAILBOX = 'mbx_1' as Id<'mailboxes'>;

beforeEach(() => {
	stateBuckets = new Map();
});

describe('usePostboxComposerStack focus surface', () => {
	it('promoting then demoting leaves the composer draft spec untouched', () => {
		const stack = usePostboxComposerStack();
		const id = stack.open({
			mailboxId: MAILBOX,
			draftId: 'drf_1' as Id<'mailDrafts'>,
			prefillSubject: 'Q3 numbers',
			prefillTo: ['a@x.com'],
		});
		const before = { ...stack.state.value.find((c) => c.id === id)! };

		stack.focus(id);
		expect(stack.focusedId.value).toBe(id);

		stack.unfocus();
		expect(stack.focusedId.value).toBeNull();

		// The spec (draft id + prefills) is preserved verbatim across the round trip.
		expect(stack.state.value.find((c) => c.id === id)).toEqual(before);
	});

	it('toggleFocusActive promotes the newest open composer then demotes it', () => {
		const stack = usePostboxComposerStack();
		stack.open({ mailboxId: MAILBOX, prefillSubject: 'first' });
		const second = stack.open({ mailboxId: MAILBOX, prefillSubject: 'second' });

		stack.toggleFocusActive();
		expect(stack.focusedId.value).toBe(second);
		stack.toggleFocusActive();
		expect(stack.focusedId.value).toBeNull();
	});

	it('does not focus a minimized composer and clears focus when the focused one docks', () => {
		const stack = usePostboxComposerStack();
		const id = stack.open({ mailboxId: MAILBOX, prefillSubject: 'draft' });

		stack.focus(id);
		expect(stack.focusedId.value).toBe(id);
		// Minimizing (docking) the focused composer demotes it.
		stack.minimize(id);
		expect(stack.focusedId.value).toBeNull();

		// A minimized composer can't be promoted.
		stack.focus(id);
		expect(stack.focusedId.value).toBeNull();
	});

	it('closing the focused composer clears focus', () => {
		const stack = usePostboxComposerStack();
		const id = stack.open({ mailboxId: MAILBOX });
		stack.focus(id);
		stack.close(id);
		expect(stack.focusedId.value).toBeNull();
	});

	it('activeComposerId is the newest non-minimized composer', () => {
		const stack = usePostboxComposerStack();
		const a = stack.open({ mailboxId: MAILBOX });
		const b = stack.open({ mailboxId: MAILBOX });
		expect(stack.activeComposerId.value).toBe(b);
		stack.minimize(b);
		expect(stack.activeComposerId.value).toBe(a);
	});
});

describe('usePostboxComposerStack bringToFront', () => {
	it('un-minimizes and moves the composer to the newest slot', () => {
		const stack = usePostboxComposerStack();
		const a = stack.open({ mailboxId: MAILBOX, prefillSubject: 'a' });
		stack.open({ mailboxId: MAILBOX, prefillSubject: 'b' });
		stack.minimize(a);

		stack.bringToFront(a);
		const last = stack.state.value[stack.state.value.length - 1]!;
		expect(last.id).toBe(a);
		expect(last.minimized).toBe(false);
	});
});
