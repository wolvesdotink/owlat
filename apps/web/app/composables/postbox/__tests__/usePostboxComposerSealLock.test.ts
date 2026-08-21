/**
 * usePostboxComposerSealLock — the composer's seal gate (Sealed Mail E5).
 *
 * The load-bearing behaviour: a draft that can't be sealed NEVER downgrades on
 * its own. Every send attempt (button, Cmd-Enter, the scheduler) is parked, the
 * sender is asked to proceed or cancel, and only confirming replays that exact
 * send — scheduled time carried over — with the explicit `allowUnsealed` bit.
 * Cancelling sends nothing and forgets the parked attempt, so the next try asks
 * again. A key change is never bypassable, and with the flag off the gate is
 * inert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, type Ref } from 'vue';

import type { SealState } from '~/utils/sealComposer';
import { createTestI18n } from '~/__tests__/i18n';
import {
	usePostboxComposerSealLock,
	type SealGateSendOptions,
} from '../usePostboxComposerSealLock';

vi.mock('@owlat/api', () => ({
	api: { mail: { drafts: { getComposerSealState: 'drafts.getComposerSealState' } } },
}));

let sealStateData: Ref<SealState | undefined>;
let flagOn: boolean;
const toasts: string[] = [];

// The gate is called outside a component, so `useI18n` is stubbed with the real
// catalog's `t` — the toast assertions below stay the English a sender reads.
const { t } = createTestI18n().global;

beforeEach(() => {
	sealStateData = ref<SealState | undefined>(undefined);
	flagOn = true;
	toasts.length = 0;
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => flagOn }));
	vi.stubGlobal('useToast', () => ({ showToast: (message: string) => void toasts.push(message) }));
	vi.stubGlobal('useConvexQuery', () => ({ data: sealStateData }));
	vi.stubGlobal('useI18n', () => ({ t }));
});

function mountGate() {
	const confirmed: SealGateSendOptions[] = [];
	const flush = vi.fn(async () => {});
	const seal = usePostboxComposerSealLock(() => 'draft-1' as never, {
		flush,
		onConfirm: (opts) => void confirmed.push(opts),
	});
	return { seal, confirmed, flush };
}

describe('usePostboxComposerSealLock', () => {
	it('lets a sealed send through untouched', async () => {
		sealStateData.value = { kind: 'willSeal' };
		const { seal, confirmed } = mountGate();
		expect(await seal.blockSend()).toBe(false);
		expect(seal.confirmOpen).toBe(false);
		expect(confirmed).toEqual([]);
	});

	it('parks an unsealable send and asks before anything goes out in plaintext', async () => {
		sealStateData.value = { kind: 'cannotSeal', reason: 'recipient_no_key' };
		const { seal, confirmed } = mountGate();
		expect(await seal.blockSend({ scheduledSendAt: 1234 })).toBe(true);
		// Blocked, prompted, and nothing sent yet.
		expect(seal.confirmOpen).toBe(true);
		expect(confirmed).toEqual([]);

		seal.confirmUnsealed();
		// The parked send is replayed exactly — scheduled time included — and the
		// plaintext consent is attached to THAT send only.
		expect(confirmed).toEqual([{ scheduledSendAt: 1234, allowUnsealed: true }]);
		expect(seal.confirmOpen).toBe(false);
		// The consented send is no longer blocked.
		expect(await seal.blockSend({ allowUnsealed: true })).toBe(false);
	});

	it('cancelling sends nothing and forgets the attempt, so the next try asks again', async () => {
		sealStateData.value = { kind: 'cannotSeal', reason: 'policy_ask' };
		const { seal, confirmed } = mountGate();
		await seal.blockSend({ scheduledSendAt: 999 });
		seal.setConfirmOpen(false);
		expect(confirmed).toEqual([]);

		// A fresh attempt with no schedule must not inherit the cancelled one.
		await seal.blockSend();
		seal.confirmUnsealed();
		expect(confirmed).toEqual([{ allowUnsealed: true }]);
	});

	it('never offers plaintext for a changed key — it points at the review instead', async () => {
		sealStateData.value = { kind: 'keyChanged', addresses: ['bob@b.test'] };
		const { seal, confirmed } = mountGate();
		expect(await seal.blockSend({ allowUnsealed: true })).toBe(true);
		expect(seal.confirmOpen).toBe(false);
		expect(confirmed).toEqual([]);
		expect(toasts).toEqual(['Review and confirm the changed recipient key before sending.']);
	});

	it('waits — visibly — while the state is still being computed', async () => {
		const { seal, flush } = mountGate();
		expect(seal.pending).toBe(true);
		expect(await seal.blockSend()).toBe(true);
		// Flushing the autosave is what lets the state settle for the next attempt.
		expect(flush).toHaveBeenCalledTimes(1);
		expect(toasts).toEqual(['Checking whether this message can be sealed…']);
		expect(seal.confirmOpen).toBe(false);
	});

	it('with no recipients there is nothing to decide, so no prompt opens', async () => {
		sealStateData.value = { kind: 'cannotSeal', reason: 'no_recipients' };
		const { seal } = mountGate();
		expect(await seal.blockSend()).toBe(true);
		expect(seal.confirmOpen).toBe(false);
		expect(toasts).toEqual(['Add a recipient to see whether this message can be sealed.']);
	});

	it('is inert when the feature flag is off', async () => {
		flagOn = false;
		const { seal } = mountGate();
		expect(seal.enabled).toBe(false);
		expect(seal.pending).toBe(false);
		expect(await seal.blockSend()).toBe(false);
	});
});
