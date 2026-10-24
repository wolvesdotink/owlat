import { describe, expect, it, vi } from 'vitest';
import {
	createReplyDropQueue,
	draggedFileCount,
	isFileDrag,
	replyDropForMessage,
	replyDropRecipient,
} from '../replyFileDrop';

function transfer(types: string[], kinds: string[] = []): DataTransfer {
	return {
		types,
		items: kinds.map((kind) => ({ kind })),
	} as unknown as DataTransfer;
}

const file = (name: string) => new File([name], name);

describe('isFileDrag', () => {
	it('takes a drag that carries files from the OS', () => {
		expect(isFileDrag(transfer(['Files']))).toBe(true);
	});

	it('leaves text, links and the list’s own row drags alone', () => {
		expect(isFileDrag(transfer(['text/plain']))).toBe(false);
		expect(isFileDrag(transfer(['text/uri-list', 'text/html']))).toBe(false);
		expect(isFileDrag(transfer(['application/x-owlat-messages']))).toBe(false);
		expect(isFileDrag(null)).toBe(false);
	});
});

describe('draggedFileCount', () => {
	it('counts the file entries of a drag still in the air', () => {
		expect(draggedFileCount(transfer(['Files'], ['file', 'file', 'string']))).toBe(2);
	});

	it('is null when the platform hides the entries', () => {
		expect(draggedFileCount(transfer(['Files'], []))).toBeNull();
		expect(draggedFileCount(undefined)).toBeNull();
	});
});

describe('replyDropRecipient', () => {
	const own = new Set(['ada@owlat.example']);

	it('names the sender, by display name when there is one', () => {
		expect(
			replyDropRecipient({ _id: 'm1', fromAddress: 'ines@example.com', fromName: 'Ines' })
		).toBe('Ines');
		expect(replyDropRecipient({ _id: 'm1', fromAddress: 'ines@example.com', fromName: ' ' })).toBe(
			'ines@example.com'
		);
	});

	it('names who one’s own message went to (its To, else its Cc) as the composer does', () => {
		const sent = {
			_id: 'm2',
			fromAddress: 'Ada <ada@owlat.example>',
			toAddresses: ['ada@owlat.example', '"Jonas Berg" <jonas@example.com>'],
			ccAddresses: ['mei@example.com'],
		};
		expect(replyDropRecipient(sent, own)).toBe('Jonas Berg');
		expect(replyDropRecipient({ ...sent, toAddresses: [] }, own)).toBe('mei');
	});

	it('is empty for one’s own message with nobody else on it', () => {
		expect(replyDropRecipient({ _id: 'm3', fromAddress: 'ada@owlat.example' }, own)).toBe('');
	});
});

describe('replyDropForMessage', () => {
	const msg = { _id: 'm1', fromAddress: 'ines@example.com', fromName: 'Ines' };

	it('replies to a list row’s message', () => {
		expect(replyDropForMessage(msg, 'inbox')).toEqual({
			kind: 'message',
			id: 'm1',
			recipient: 'Ines',
		});
	});

	it('takes no drop on a draft', () => {
		expect(replyDropForMessage(msg, 'drafts')).toBeNull();
	});

	it('treats a row in Sent as one’s own message', () => {
		const sent = {
			_id: 'm2',
			fromAddress: 'ada@owlat.example',
			fromName: 'Ada',
			toAddresses: ['jonas@example.com'],
		};
		expect(replyDropForMessage(sent, 'sent')?.recipient).toBe('jonas');
		expect(replyDropForMessage(sent, 'inbox')?.recipient).toBe('Ada');
	});
});

describe('createReplyDropQueue', () => {
	it('hands a conversation its files once, oldest first', () => {
		const onChange = vi.fn();
		const queue = createReplyDropQueue(onChange);
		const [a, b, c] = [file('a'), file('b'), file('c')];
		queue.queue({ kind: 'message', id: 'm1' }, [a, b]);
		queue.queue({ kind: 'message', id: 'm1' }, [c]);
		expect(queue.has({ kind: 'message', id: 'm1' })).toBe(true);
		expect(queue.take({ kind: 'message', id: 'm1' })).toEqual([a, b, c]);
		expect(queue.take({ kind: 'message', id: 'm1' })).toEqual([]);
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	it('never hands one conversation’s files to another, across kinds too', () => {
		const queue = createReplyDropQueue();
		const a = file('a');
		queue.queue({ kind: 'team', id: 'x1' }, [a]);
		expect(queue.take({ kind: 'message', id: 'x1' })).toEqual([]);
		expect(queue.take({ kind: 'team', id: 'x2' })).toEqual([]);
		expect(queue.take({ kind: 'team', id: 'x1' })).toEqual([a]);
	});

	it('forgets one drop, one conversation, or everything', () => {
		const queue = createReplyDropQueue();
		const first = queue.queue({ kind: 'message', id: 'm1' }, [file('a')]);
		queue.queue({ kind: 'message', id: 'm1' }, [file('b')]);
		queue.queue({ kind: 'team', id: 't1' }, [file('c')]);

		queue.remove(first);
		expect(queue.take({ kind: 'message', id: 'm1' }).map((f) => f.name)).toEqual(['b']);

		expect(queue.clear({ kind: 'team', id: 't1' })).toBe(true);
		expect(queue.clear({ kind: 'team', id: 't1' })).toBe(false);

		queue.queue({ kind: 'message', id: 'm2' }, [file('d')]);
		queue.clearAll();
		expect(queue.has({ kind: 'message', id: 'm2' })).toBe(false);
	});
});
