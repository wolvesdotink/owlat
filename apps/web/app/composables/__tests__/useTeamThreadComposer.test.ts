import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import { useTeamThreadComposer } from '../useTeamThreadComposer';

// Called outside a component here, so `useI18n` is stubbed with the real
// catalog's `t`.
const { t, locale } = createTestI18n().global;

/**
 * #812 — the Team inbox thread as a composer target. The send path follows the
 * message's state, a value-shaped refusal reads as "not sent", and a held or
 * busy composer never sends twice.
 */
describe('useTeamThreadComposer', () => {
	const target = {
		kind: 'teamThread' as const,
		threadId: 'th_1' as never,
		inboundMessageId: 'in_1' as never,
	};
	const reply = { body: 'We refunded invoice 4472.', subject: 'Re: Invoice 4471' };
	const sent = { ok: true as const, result: { success: true } };

	let showToast: ReturnType<typeof vi.fn>;
	let ops: {
		approve: ReturnType<typeof vi.fn>;
		saveAndApprove: ReturnType<typeof vi.fn>;
		saveRevision: ReturnType<typeof vi.fn>;
		sendFollowUp: ReturnType<typeof vi.fn>;
		takeOver: ReturnType<typeof vi.fn>;
	};
	let status: string;
	let held: boolean;

	beforeEach(() => {
		showToast = vi.fn();
		vi.stubGlobal('useI18n', () => ({ t, locale }));
		vi.stubGlobal('useToast', () => ({ showToast }));
		ops = {
			approve: vi.fn().mockResolvedValue(sent),
			saveAndApprove: vi.fn().mockResolvedValue(sent),
			saveRevision: vi.fn().mockResolvedValue(sent),
			sendFollowUp: vi.fn().mockResolvedValue({ ok: true, result: { followUpId: 'fu_1' } }),
			takeOver: vi.fn().mockResolvedValue({ ok: true, result: null }),
		};
		status = 'draft_ready';
		held = false;
	});

	function composer(currentTarget: typeof target | null = target) {
		return useTeamThreadComposer(
			{ target: () => currentTarget, processingStatus: () => status, held: () => held },
			ops as never
		);
	}

	it('approves an unchanged agent draft as is', async () => {
		expect(await composer().send(reply, true)).toBe('reply');
		expect(ops.approve).toHaveBeenCalledWith('in_1');
		expect(ops.saveAndApprove).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith(t('dashboard.inbox.detail.replySentToast'));
	});

	it('saves what the person typed as the working draft, then approves it', async () => {
		expect(await composer().send(reply, false)).toBe('reply');
		expect(ops.saveAndApprove).toHaveBeenCalledWith('in_1', reply);
		expect(ops.approve).not.toHaveBeenCalled();
	});

	it('takes over a message no agent will answer before sending', async () => {
		status = 'failed';
		expect(await composer().send(reply, false)).toBe('reply');
		expect(ops.takeOver).toHaveBeenCalledWith('in_1');
		expect(ops.takeOver.mock.invocationCallOrder[0]).toBeLessThan(
			ops.saveAndApprove.mock.invocationCallOrder[0]!
		);
	});

	it('stops when the takeover fails', async () => {
		status = 'failed';
		ops.takeOver.mockResolvedValueOnce({ ok: false });
		expect(await composer().send(reply, false)).toBeNull();
		expect(ops.saveAndApprove).not.toHaveBeenCalled();
	});

	it('sends a follow-up on an answered message, never the draft path', async () => {
		status = 'sent';
		expect(await composer().send(reply, false)).toBe('followUp');
		expect(ops.sendFollowUp).toHaveBeenCalledWith(reply);
		expect(ops.saveAndApprove).not.toHaveBeenCalled();
		expect(ops.approve).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith(t('dashboard.inbox.detail.followUpSentToast'));
	});

	it('reads a teammate’s reply collision as not sent, and says who', async () => {
		ops.saveAndApprove.mockResolvedValueOnce({
			ok: true,
			result: { success: false, reason: 'reply_in_progress', heldByName: 'Jordan' },
		});
		expect(await composer().send(reply, false)).toBeNull();
		expect(showToast).toHaveBeenCalledWith(
			t('shared.replyCollision.collisionToast', { name: 'Jordan' }),
			'error'
		);
		expect(showToast).not.toHaveBeenCalledWith(t('dashboard.inbox.detail.replySentToast'));
	});

	it('reads a message someone already handled as not sent', async () => {
		ops.approve.mockResolvedValueOnce({
			ok: true,
			result: { success: false, reason: 'not_found' },
		});
		expect(await composer().send(reply, true)).toBeNull();
		expect(showToast).toHaveBeenCalledWith(t('shared.reviewApprove.alreadyHandled'), 'info');
	});

	it('does not send while a teammate is replying, or with nothing to answer', async () => {
		held = true;
		expect(await composer().send(reply, false)).toBeNull();
		held = false;
		expect(await composer(null).send(reply, false)).toBeNull();
		expect(ops.saveAndApprove).not.toHaveBeenCalled();
	});

	it('sends once when Send fires twice', async () => {
		const c = composer();
		const first = c.send(reply, false);
		expect(c.busy.value).toBe(true);
		expect(await c.send(reply, false)).toBeNull();
		expect(await first).toBe('reply');
		expect(c.busy.value).toBe(false);
		expect(ops.saveAndApprove).toHaveBeenCalledOnce();
	});

	it('saves a draft revision without sending, even while a teammate is replying', async () => {
		held = true;
		expect(await composer().save(reply)).toBe(true);
		expect(ops.saveRevision).toHaveBeenCalledWith('in_1', reply);
		expect(ops.approve).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith(
			t('dashboard.inbox.detail.toasts.draftSavedNotApproved')
		);
	});

	it('reports a failed save', async () => {
		ops.saveRevision.mockResolvedValueOnce({ ok: false });
		expect(await composer().save(reply)).toBe(false);
		expect(showToast).not.toHaveBeenCalled();
	});
});
