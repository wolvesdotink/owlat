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
import { computeAttachmentSuggestions } from '../attachmentSuggest';
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
});
