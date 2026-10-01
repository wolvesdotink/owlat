/**
 * Tests for computeAttachmentSuggestions (inbox/attachmentSuggest.ts).
 *
 * Asserts the contact-scoping data-isolation gate is threaded verbatim into the
 * semanticFiles search, the best match surfaces as a single confident
 * suggestion, an ambiguous match is flagged (so clarify asks), and the whole
 * thing is fail-soft + read-only (it never attaches — the autonomous send path
 * consumes nothing here).
 */

import { describe, it, expect, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { computeAttachmentSuggestions, searchFilesForRequest } from '../attachmentSuggest';
import type { Id } from '../../_generated/dataModel';

type SearchArgs = { queryText?: string; scopeToContact: unknown; limit?: number };

/** Fake file row shaped like a `semanticFiles` doc from the search action. */
function fileRow(id: string, score: number, over: Record<string, unknown> = {}) {
	return {
		_id: id as Id<'semanticFiles'>,
		storageId: `store_${id}` as Id<'_storage'>,
		filename: `${id}.pdf`,
		title: `Title ${id}`,
		mimeType: 'application/pdf',
		fileSize: 1234,
		url: null,
		_score: score,
		...over,
	};
}

/** Build an execute-style ctx whose runAction returns the given file rows and
 * records the args the search was called with. */
function makeCtx(files: unknown[], onSearch?: (args: SearchArgs) => void) {
	const calls: { name: string; args: SearchArgs }[] = [];
	const runAction = vi.fn(async (ref: unknown, args: SearchArgs) => {
		const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
		calls.push({ name, args });
		onSearch?.(args);
		return files;
	});
	return { ctx: { runAction: runAction as never }, calls, runAction };
}

const CONTACT = 'contact_abc' as Id<'contacts'>;

describe('computeAttachmentSuggestions', () => {
	it('scopes the file search to the resolved contact and surfaces the best match', async () => {
		const { ctx, calls } = makeCtx([fileRow('best', 0.95), fileRow('other', 0.1)]);
		const result = await computeAttachmentSuggestions(ctx, {
			context: 'Can you send me the signed contract?',
			contactId: CONTACT,
		});
		expect(result).not.toBeNull();
		expect(result!.ambiguous).toBe(false);
		expect(result!.candidates).toHaveLength(1);
		expect(result!.candidates[0]!.fileId).toBe('best');
		expect(result!.candidates[0]!.storageId).toBe('store_best');
		expect(result!.candidates[0]!.mimeType).toBe('application/pdf');
		// Data-isolation gate: the search is scoped to the inbound's contact.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toContain('semanticSearch');
		expect(calls[0]!.args.scopeToContact).toBe(CONTACT);
	});

	it('fails closed to org-general-only when there is no resolved contact', async () => {
		const { ctx, calls } = makeCtx([fileRow('a', 0.9)]);
		await computeAttachmentSuggestions(ctx, {
			context: 'Please forward the invoice.',
			contactId: undefined,
		});
		expect(calls[0]!.args.scopeToContact).toBe('org-general-only');
	});

	it('flags an ambiguous match so the clarify loop can ask instead of guessing', async () => {
		const { ctx } = makeCtx([fileRow('a', 0.6), fileRow('b', 0.58), fileRow('c', 0.55)]);
		const result = await computeAttachmentSuggestions(ctx, {
			context: 'Can you send me the contract?',
			contactId: CONTACT,
		});
		expect(result).not.toBeNull();
		expect(result!.ambiguous).toBe(true);
		expect(result!.candidates.length).toBeGreaterThanOrEqual(2);
	});

	it('does not search (read-only, no suggestion) when no document is requested', async () => {
		const { ctx, runAction } = makeCtx([fileRow('a', 0.9)]);
		const result = await computeAttachmentSuggestions(ctx, {
			context: 'Thanks for the update, talk soon.',
			contactId: CONTACT,
		});
		expect(result).toBeNull();
		expect(runAction).not.toHaveBeenCalled();
	});

	it('fails soft to null when the file search throws', async () => {
		const ctx = {
			runAction: vi.fn(async () => {
				throw new Error('vector search unavailable');
			}) as never,
		};
		const result = await computeAttachmentSuggestions(ctx, {
			context: 'Can you send me the report?',
			contactId: CONTACT,
		});
		expect(result).toBeNull();
	});

	it('returns null when the scoped search yields no files', async () => {
		const { ctx } = makeCtx([]);
		const result = await computeAttachmentSuggestions(ctx, {
			context: 'Can you send me the report?',
			contactId: CONTACT,
		});
		expect(result).toBeNull();
	});

	it('is advisory only — never performs a mutation / attach (auto-send never attaches)', async () => {
		// The autonomous send path never attaches (recipient-lock forbids a new
		// attachment on an unattended reply); suggestions are pure read-only
		// metadata. Prove it: computing a suggestion issues NO mutation — only the
		// read-only file search — so nothing here can turn into a real attachment.
		const runMutation = vi.fn();
		const runAction = vi.fn(async () => [fileRow('a', 0.95), fileRow('b', 0.1)]);
		const ctx = { runAction: runAction as never, runMutation: runMutation as never };
		const result = await computeAttachmentSuggestions(ctx, {
			context: 'Can you send me the signed contract?',
			contactId: CONTACT,
		});
		expect(result).not.toBeNull();
		expect(runMutation).not.toHaveBeenCalled();
	});
});

describe('searchFilesForRequest (Answer mode)', () => {
	const MAILBOX = 'mailbox_1' as Id<'mailboxes'>;

	function makeSearchCtx(opts: { files?: unknown[]; mail?: unknown[]; failFiles?: boolean }) {
		const actions: { name: string; args: SearchArgs }[] = [];
		const queries: { name: string; args: Record<string, unknown> }[] = [];
		const ctx = {
			runAction: vi.fn(async (ref: unknown, args: SearchArgs) => {
				actions.push({ name: getFunctionName(ref as never), args });
				if (opts.failFiles) throw new Error('search down');
				return opts.files ?? [];
			}),
			runQuery: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
				queries.push({ name: getFunctionName(ref as never), args });
				return opts.mail ?? [];
			}),
		};
		return { ctx: ctx as never, actions, queries };
	}

	it('merges contact-scoped Files hits with the mailbox’s own attachments', async () => {
		const { ctx, actions, queries } = makeSearchCtx({
			files: [fileRow('f1', 0.4), fileRow('gone', 0.9, { storageId: undefined })],
			mail: [{ id: 'm1', filename: 'invoice-09.pdf', contentType: 'application/pdf', size: 99 }],
		});
		const found = await searchFilesForRequest(ctx, {
			query: 'invoice for september',
			contactId: CONTACT,
			mailboxScope: { mailboxId: MAILBOX, counterparts: ['jonas@example.com'] },
		});
		expect(actions[0]!.args).toMatchObject({
			scopeToContact: CONTACT,
			queryText: 'invoice for september',
		});
		expect(queries[0]).toMatchObject({
			name: 'mail/attachExisting:searchMailboxAttachments',
			// The mailbox leg carries the counterpart scope (no mailbox-wide search).
			args: { scope: { mailboxId: MAILBOX, counterparts: ['jonas@example.com'] } },
		});
		// A Files row whose bytes were released cannot be offered.
		expect(found).toEqual([
			expect.objectContaining({ source: 'semanticFile', id: 'f1', score: 0.4 }),
			{
				source: 'mailAttachment',
				id: 'm1',
				filename: 'invoice-09.pdf',
				mimeType: 'application/pdf',
				size: 99,
				score: 0,
			},
		]);
	});

	it('scopes to org-general files without a contact and skips the mailbox leg without a mailbox', async () => {
		const { ctx, actions, queries } = makeSearchCtx({ files: [] });
		await searchFilesForRequest(ctx, { query: 'price list' });
		expect(actions[0]!.args.scopeToContact).toBe('org-general-only');
		expect(queries).toEqual([]);
	});

	it('fails soft: a broken Files search still returns the mailbox hits', async () => {
		const { ctx } = makeSearchCtx({
			failFiles: true,
			mail: [{ id: 'm1', filename: 'a.pdf', contentType: 'application/pdf', size: 1 }],
		});
		const found = await searchFilesForRequest(ctx, {
			query: 'a',
			mailboxScope: { mailboxId: MAILBOX, counterparts: ['jonas@example.com'] },
		});
		expect(found.map((f) => f.id)).toEqual(['m1']);
	});
});
