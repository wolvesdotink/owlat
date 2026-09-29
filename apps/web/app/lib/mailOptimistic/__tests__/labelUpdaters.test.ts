import { describe, it, expect } from 'vitest';
import { api } from '@owlat/api';
import { fakeLocalStore } from './fakeLocalStore';
import { optimisticReorderLabels, optimisticUpdateLabel } from '../labelUpdaters';

/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures cast loose ids into branded types */

const MB = 'mb1';
const list = api.mail.labels.list;
const thread = api.mail.mailbox.messages.listThreadMessages;

function label(id: string, over: Record<string, unknown> = {}) {
	return { _id: id, mailboxId: MB, name: id, createdAt: 1, ...over };
}

function seed() {
	const fake = fakeLocalStore();
	const labels = [
		label('l1', { color: '#ff0000', parentId: 'l0' }),
		label('l2', { order: 5 }),
		label('l3'),
	];
	fake.seed(list, { mailboxId: MB }, labels);
	fake.seed(
		thread,
		{ messageId: 'm1' },
		{ thread: null, labels, messages: [], envelopes: [], olderCursor: null }
	);
	return fake;
}

const run = (fake: ReturnType<typeof fakeLocalStore>, updater: any, args: any) =>
	updater(fake.store, args);

describe('optimisticUpdateLabel', () => {
	it('renames, pins and recolours in the rail and in the open conversation', () => {
		const fake = seed();
		run(fake, optimisticUpdateLabel, {
			labelId: 'l2',
			name: '  Clients ',
			isPinned: true,
			color: '#00ff00',
		});
		const railed = fake.get(list, { mailboxId: MB })[1];
		expect(railed).toMatchObject({ name: 'Clients', isPinned: true, color: '#00ff00' });
		expect(fake.get(thread, { messageId: 'm1' }).labels[1]).toEqual(railed);
	});

	it('clears the colour on an empty string and detaches on a null parent', () => {
		const fake = seed();
		run(fake, optimisticUpdateLabel, { labelId: 'l1', color: '', parentId: null });
		const railed = fake.get(list, { mailboxId: MB })[0];
		expect('color' in railed).toBe(false);
		expect('parentId' in railed).toBe(false);
	});

	it('keeps the old name for a blank rename, which the server refuses', () => {
		const fake = seed();
		run(fake, optimisticUpdateLabel, { labelId: 'l3', name: '   ' });
		expect(fake.get(list, { mailboxId: MB })[2].name).toBe('l3');
	});

	it('leaves other labels untouched by reference', () => {
		const fake = seed();
		const before = fake.get(list, { mailboxId: MB });
		run(fake, optimisticUpdateLabel, { labelId: 'l3', order: 2 });
		const after = fake.get(list, { mailboxId: MB });
		expect(after[0]).toBe(before[0]);
		expect(after[2].order).toBe(2);
	});
});

describe('optimisticReorderLabels', () => {
	it('stamps the new sibling order 0..n-1', () => {
		const fake = seed();
		run(fake, optimisticReorderLabels, { mailboxId: MB, labelIds: ['l3', 'l2', 'l1'] });
		const orders = Object.fromEntries(
			fake.get(list, { mailboxId: MB }).map((l: any) => [l._id, l.order])
		);
		expect(orders).toEqual({ l1: 2, l2: 1, l3: 0 });
	});

	it('writes nothing when the order already holds', () => {
		const fake = fakeLocalStore();
		const labels = [label('l1', { order: 0 }), label('l2', { order: 1 })];
		fake.seed(list, { mailboxId: MB }, labels);
		run(fake, optimisticReorderLabels, { mailboxId: MB, labelIds: ['l1', 'l2'] });
		expect(fake.get(list, { mailboxId: MB })).toBe(labels);
	});
});
