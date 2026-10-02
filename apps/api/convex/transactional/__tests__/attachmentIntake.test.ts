/**
 * The storage half of the transactional attachment handoff, driven with a fake
 * action context so each storage and mutation step can fail on cue. The fake
 * keeps the pending-row bookkeeping `transactional/pendingUploads.ts` does, so
 * "which blobs survive" is asserted against the same rule the real mutations
 * apply: release deletes only what is still pending.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import {
	prepareAttachments,
	uploadAndDispatch,
	type PreparedAttachment,
} from '../attachmentIntake';

beforeEach(() => {
	vi.stubEnv('OWLAT_DEV_MODE', 'true');
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type DispatchArgs = { attachmentRefs?: { storageId?: string }[]; uploadsPending?: boolean };

interface FakeOptions {
	storeFailsOn?: number;
	getUrlNull?: boolean;
	registerFails?: boolean;
	releaseFails?: boolean;
	dispatch?: (args: DispatchArgs, claim: () => void) => unknown;
}

function fakeCtx(opts: FakeOptions = {}) {
	const blobs = new Set<string>();
	const pending = new Set<string>();
	let stores = 0;
	const dispatchCalls: DispatchArgs[] = [];
	const ctx = {
		storage: {
			store: vi.fn(async () => {
				stores++;
				if (opts.storeFailsOn === stores) throw new Error('storage unavailable');
				const id = `blob-${stores}`;
				blobs.add(id);
				return id;
			}),
			getUrl: vi.fn(async (id: string) =>
				opts.getUrlNull ? null : `https://files.example.com/${id}`
			),
			delete: vi.fn(async (id: string) => {
				blobs.delete(id);
			}),
		},
		runMutation: vi.fn(async (ref: Parameters<typeof getFunctionName>[0], args: any) => {
			const name = getFunctionName(ref);
			if (name === 'transactional/pendingUploads:register') {
				if (opts.registerFails) throw new Error('register failed');
				pending.add(args.storageId);
				return null;
			}
			if (name === 'transactional/pendingUploads:release') {
				if (opts.releaseFails) throw new Error('release failed');
				for (const id of args.storageIds as string[]) {
					if (pending.delete(id)) blobs.delete(id);
				}
				return null;
			}
			if (name === 'transactional/dispatch:dispatch') {
				dispatchCalls.push(args);
				// Claiming is what the real dispatch does in the Send's transaction.
				const claim = () => {
					for (const ref of (args as DispatchArgs).attachmentRefs ?? []) {
						if (ref.storageId) pending.delete(ref.storageId);
					}
				};
				return opts.dispatch ? opts.dispatch(args, claim) : (claim(), queued);
			}
			throw new Error(`unexpected mutation ${name}`);
		}),
	};
	return {
		ctx: ctx as unknown as Parameters<typeof uploadAndDispatch>[0],
		blobs,
		pending,
		dispatchCalls,
	};
}

const queued = {
	ok: true,
	sendId: 'send-1',
	contactId: 'contact-1',
	contactCreated: true,
	language: 'en',
	queued: true,
};

const request = {
	templateLookup: { kind: 'slug' as const, slug: 'invoice' },
	email: 'to@example.com',
};

function prepared(count: number): PreparedAttachment[] {
	const result = prepareAttachments(
		Array.from({ length: count }, (_, i) => ({
			filename: `file-${i}.pdf`,
			content: Buffer.from(`content ${i}`).toString('base64'),
		}))
	);
	if (!result.ok) throw new Error('fixture attachments must validate');
	return result.prepared;
}

describe('uploadAndDispatch — stored bytes after a failure', () => {
	it('releases the first blob when storing the second one fails', async () => {
		const fake = fakeCtx({ storeFailsOn: 2 });

		await expect(uploadAndDispatch(fake.ctx, prepared(2), request)).rejects.toThrow(
			'storage unavailable'
		);

		expect(fake.blobs.size).toBe(0);
		expect(fake.pending.size).toBe(0);
		expect(fake.dispatchCalls).toHaveLength(0);
	});

	it('releases every stored blob when a storage URL cannot be resolved', async () => {
		const fake = fakeCtx({ getUrlNull: true });

		const result = await uploadAndDispatch(fake.ctx, prepared(2), request);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(500);
		expect(fake.blobs.size).toBe(0);
		expect(fake.dispatchCalls).toHaveLength(0);
	});

	it('deletes a blob directly when its pending row could not be written', async () => {
		const fake = fakeCtx({ registerFails: true });

		await expect(uploadAndDispatch(fake.ctx, prepared(1), request)).rejects.toThrow(
			'register failed'
		);

		expect(fake.blobs.size).toBe(0);
	});

	it('releases the blobs when dispatch throws before committing', async () => {
		const fake = fakeCtx({
			dispatch: () => {
				throw new Error('dispatch failed');
			},
		});

		await expect(uploadAndDispatch(fake.ctx, prepared(2), request)).rejects.toThrow(
			'dispatch failed'
		);

		expect(fake.blobs.size).toBe(0);
	});

	it('keeps the blobs when dispatch committed but its acknowledgment was lost', async () => {
		const fake = fakeCtx({
			dispatch: (_args, claim) => {
				claim();
				throw new Error('connection lost after commit');
			},
		});

		await expect(uploadAndDispatch(fake.ctx, prepared(2), request)).rejects.toThrow(
			'connection lost after commit'
		);

		// The Send owns them now: the release found no pending row to act on.
		expect([...fake.blobs]).toEqual(['blob-1', 'blob-2']);
	});

	it('releases the blobs when dispatch refuses', async () => {
		const fake = fakeCtx({
			dispatch: () => ({ ok: false, reason: 'template_not_found' }),
		});

		const result = await uploadAndDispatch(fake.ctx, prepared(1), request);

		expect(result).toEqual({ ok: true, outcome: { ok: false, reason: 'template_not_found' } });
		expect(fake.blobs.size).toBe(0);
	});

	it('hands every stored blob to a successful dispatch to claim', async () => {
		const fake = fakeCtx();

		const result = await uploadAndDispatch(fake.ctx, prepared(2), request);

		expect(result).toEqual({ ok: true, outcome: queued });
		// Ignored by this dispatch; kept for a rollback to the v0.6.7 dispatch.
		expect(fake.dispatchCalls[0]?.uploadsPending).toBe(true);
		expect(fake.dispatchCalls[0]?.attachmentRefs?.map((ref) => ref.storageId)).toEqual([
			'blob-1',
			'blob-2',
		]);
		expect(fake.blobs.size).toBe(2);
		expect(fake.pending.size).toBe(0);
	});

	it('still returns the refusal when the release itself fails', async () => {
		const fake = fakeCtx({
			releaseFails: true,
			dispatch: () => ({ ok: false, reason: 'domain_unverified' }),
		});

		const result = await uploadAndDispatch(fake.ctx, prepared(1), request);

		expect(result).toEqual({ ok: true, outcome: { ok: false, reason: 'domain_unverified' } });
		// Left pending for the expiry sweep rather than lost.
		expect(fake.pending.size).toBe(1);
	});
});

describe('prepareAttachments — the whole list is checked first', () => {
	it('refuses a list whose third entry is invalid, with nothing decoded for storage', () => {
		const result = prepareAttachments([
			{ filename: 'a.pdf', content: 'YQ==' },
			{ filename: 'b.pdf', url: 'https://files.example.com/b.pdf' },
			{ filename: 'c.pdf' },
		]);

		expect(result.ok).toBe(false);
	});

	it('refuses a non-object entry with a 400 rather than throwing', async () => {
		const result = prepareAttachments([null as never]);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(400);
	});

	it('decodes exactly the bytes that were encoded', () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
		const result = prepareAttachments([
			{ filename: 'all.bin', content: Buffer.from(bytes).toString('base64') },
		]);

		expect(result.ok).toBe(true);
		if (result.ok) {
			const [att] = result.prepared;
			expect(att && 'bytes' in att ? Array.from(att.bytes) : null).toEqual(Array.from(bytes));
		}
	});
});
