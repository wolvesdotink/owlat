import { describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxReplyQueueCount } from '../usePostboxReplyQueueCount';

describe('usePostboxReplyQueueCount', () => {
	it('subscribes only to the count, with the same args as the Answer badge, and skips an absent mailbox', () => {
		const mailbox = ref<Id<'mailboxes'> | null>('mbx' as Id<'mailboxes'>);
		const data = ref<number>();
		let args!: () => unknown;
		const query = vi.fn((fn, factory) => {
			expect(getFunctionName(fn)).toBe(getFunctionName(api.mail.needsReply.countQueue));
			args = factory;
			return { data, isLoading: ref(false) };
		});
		vi.stubGlobal('useConvexQuery', query);
		const scope = effectScope();
		const result = scope.run(() => usePostboxReplyQueueCount(mailbox))!;
		expect(args()).toEqual({ mailboxId: 'mbx' });
		expect(result.count.value).toBe(0);
		data.value = 4;
		expect(result.count.value).toBe(4);
		mailbox.value = null;
		expect(args()).toBe('skip');
		scope.stop();
	});
});
