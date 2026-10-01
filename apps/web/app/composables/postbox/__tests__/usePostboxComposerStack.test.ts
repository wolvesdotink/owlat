/**
 * usePostboxComposerStack: the popup stack bookkeeping.
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

describe('usePostboxComposerStack', () => {
	it('opens a composer with its seed kept verbatim', () => {
		const stack = usePostboxComposerStack();
		const id = stack.open({
			mailboxId: MAILBOX,
			draftId: 'drf_1' as Id<'mailDrafts'>,
			prefillSubject: 'Q3 numbers',
			prefillTo: ['a@x.com'],
		});
		expect(stack.state.value.find((c) => c.id === id)).toMatchObject({
			minimized: false,
			draftId: 'drf_1',
			prefillSubject: 'Q3 numbers',
			prefillTo: ['a@x.com'],
		});
		stack.close(id);
		expect(stack.state.value).toEqual([]);
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
