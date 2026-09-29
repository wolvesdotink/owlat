/**
 * The shared voice-guidance lookup (mail/ai/voiceGuidance.ts). A mailbox id
 * that came from the client must be proven readable before its learned voice
 * is read, or a foreign id would fold another user's phrasings into a prompt.
 */

import { describe, it, expect, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { Id } from '../../_generated/dataModel';
import { formatVoiceSection, loadVoiceGuidance } from '../ai/voiceGuidance';

const MAILBOX = 'mbx1' as Id<'mailboxes'>;

function makeCtx(opts: { readable: boolean; guidance?: string | null; throws?: boolean }) {
	const runQuery = vi.fn(async (ref: unknown) => {
		expect(getFunctionName(ref as never)).toBe('mail/mailbox/identity:get');
		return opts.readable ? { _id: MAILBOX } : null;
	});
	const runMutation = vi.fn(async (ref: unknown) => {
		expect(getFunctionName(ref as never)).toBe('mail/ai/voiceProfile:getGuidanceForMailbox');
		if (opts.throws) throw new Error('boom');
		return { guidance: opts.guidance ?? null };
	});
	return { ctx: { runQuery, runMutation } as never, runQuery, runMutation };
}

describe('loadVoiceGuidance', () => {
	it('requireAccess with a foreign mailbox gives null and never reads the profile', async () => {
		const h = makeCtx({ readable: false, guidance: 'Sign off with "Cheers, Sam".' });
		const guidance = await loadVoiceGuidance(h.ctx, { mailboxId: MAILBOX, requireAccess: true });
		expect(guidance).toBeNull();
		expect(h.runQuery).toHaveBeenCalledTimes(1);
		expect(h.runMutation).not.toHaveBeenCalled();
	});

	it('requireAccess with a readable mailbox returns its guidance', async () => {
		const h = makeCtx({ readable: true, guidance: 'Keep it short.' });
		expect(await loadVoiceGuidance(h.ctx, { mailboxId: MAILBOX, requireAccess: true })).toBe(
			'Keep it short.'
		);
	});

	it('without requireAccess reads the profile directly', async () => {
		const h = makeCtx({ readable: false, guidance: 'Keep it short.' });
		expect(await loadVoiceGuidance(h.ctx, { mailboxId: MAILBOX, requireAccess: false })).toBe(
			'Keep it short.'
		);
		expect(h.runQuery).not.toHaveBeenCalled();
	});

	it('is fail-soft: no mailbox or a failing lookup gives null', async () => {
		const none = makeCtx({ readable: true });
		expect(await loadVoiceGuidance(none.ctx, { mailboxId: undefined, requireAccess: true })).toBe(
			null
		);
		expect(none.runQuery).not.toHaveBeenCalled();
		const failing = makeCtx({ readable: true, throws: true });
		expect(
			await loadVoiceGuidance(failing.ctx, { mailboxId: MAILBOX, requireAccess: false })
		).toBeNull();
	});
});

describe('formatVoiceSection', () => {
	it('is empty without guidance and a separated section with it', () => {
		expect(formatVoiceSection(null)).toBe('');
		expect(formatVoiceSection('')).toBe('');
		expect(formatVoiceSection('Keep it short.')).toBe('\n\nKeep it short.');
	});
});
