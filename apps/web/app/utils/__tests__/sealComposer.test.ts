/**
 * Composer-lock derivation honesty audit (Sealed Mail E5). Every reachable
 * string maps 1:1 to a `sealState`; `willSeal` is the ONLY state that promises
 * encryption, and only `cannotSeal` permits an explicit unsealed send — which is
 * always a proceed-or-cancel decision (`deriveUnsealedPrompt`), never a silent
 * downgrade.
 */
import { describe, it, expect } from 'vitest';
import {
	deriveComposerLock,
	deriveUnsealedPrompt,
	sealSendBlock,
	type SealSkipReason,
	type SealState,
} from '../sealComposer';
import { createTestI18n, localizedWith } from '~/__tests__/i18n';

/**
 * The derivation carries catalog keys, so the audit renders them against the
 * real English catalog: what is pinned below is the sentence a sender reads.
 */
const { t } = createTestI18n().global;
const render = localizedWith(t);

describe('deriveComposerLock', () => {
	it('willSeal: verbatim promise copy, ok tone, no unsealed escape hatch', () => {
		const lock = deriveComposerLock({ kind: 'willSeal' });
		expect(lock.kind).toBe('willSeal');
		expect(t(lock.summary)).toBe('This message will be sealed');
		expect(render(lock.detail)).toBe(
			'Everyone you are writing to can receive sealed mail, so Owlat will encrypt this message before it leaves your workspace.'
		);
		expect(lock.tone).toBe('ok');
		expect(lock.allowSendUnsealed).toBe(false);
	});

	it('keyChanged: verbatim copy names the rotated recipients, warn tone, no silent send', () => {
		const lock = deriveComposerLock({ kind: 'keyChanged', addresses: ['bob@b.test'] });
		expect(lock.kind).toBe('keyChanged');
		expect(t(lock.summary)).toBe("A recipient's key changed");
		expect(render(lock.detail)).toBe(
			'The sealing key for bob@b.test changed since you last sealed mail to them. Open your conversation with them to review and confirm the new key before Owlat will seal to it.'
		);
		expect(lock.tone).toBe('warn');
		// keyChanged never auto-seals AND is not a plaintext escape hatch — it must
		// be resolved (re-accept) first.
		expect(lock.allowSendUnsealed).toBe(false);
	});

	it('keyChanged: joins multiple addresses in plain language', () => {
		const lock = deriveComposerLock({
			kind: 'keyChanged',
			addresses: ['bob@b.test', 'carol@c.test'],
		});
		expect(render(lock.detail)).toContain('bob@b.test and carol@c.test');
	});

	it('cannotSeal: muted tone, and sending unsealed is an EXPLICIT act', () => {
		const lock = deriveComposerLock({ kind: 'cannotSeal', reason: 'recipient_no_key' });
		expect(lock.kind).toBe('cannotSeal');
		expect(t(lock.summary)).toBe("This message won't be sealed");
		expect(lock.tone).toBe('muted');
		expect(lock.allowSendUnsealed).toBe(true);
	});

	it('no state yet: says it is still checking instead of claiming nothing', () => {
		const lock = deriveComposerLock(null);
		expect(lock.kind).toBe('checking');
		expect(t(lock.summary)).toBe('Checking whether this message can be sealed');
		expect(render(lock.detail)).toBe(
			'Owlat is looking up whether everyone you are writing to can receive sealed mail. This updates as you change recipients.'
		);
		expect(lock.tone).toBe('muted');
		// An unanswered state is never a plaintext decision the sender can take.
		expect(lock.allowSendUnsealed).toBe(false);
	});

	it('cannotSeal(no_recipients): nothing to decide yet, so no unsealed control', () => {
		const lock = deriveComposerLock({ kind: 'cannotSeal', reason: 'no_recipients' });
		expect(lock.allowSendUnsealed).toBe(false);
	});

	// Verbatim per-reason copy — the honesty audit for cannotSeal explanations.
	const REASON_COPY: Record<SealSkipReason, string> = {
		policy_off:
			'Sealed mail is turned off for your workspace, so this message will be sent normally.',
		recipient_no_key:
			"Some of your recipients can't receive sealed mail yet, so this message will be sent normally.",
		no_recipients: 'Add a recipient to see whether this message can be sealed.',
		no_signing_key:
			"This address doesn't have a sealing key yet, so this message will be sent normally.",
		policy_ask:
			'Sealed mail is available for these recipients, but your workspace is set to ask before sealing, so this message will be sent normally.',
		flag_off: 'Sealed mail is not available yet, so this message will be sent normally.',
		key_changed:
			"A recipient's key changed and needs review, so this message will be sent normally until you confirm it.",
	};

	it.each(Object.keys(REASON_COPY) as SealSkipReason[])(
		'cannotSeal(%s) renders its verbatim reason copy and never over-claims',
		(reason) => {
			const lock = deriveComposerLock({ kind: 'cannotSeal', reason });
			expect(render(lock.detail)).toBe(REASON_COPY[reason]);
			// No cannotSeal state may ever read as a sealing promise.
			expect(t(lock.summary)).not.toContain('will be sealed');
		}
	);

	it('willSeal + all recipients verified: says so, and still promises only sealing', () => {
		const lock = deriveComposerLock({ kind: 'willSeal' }, true);
		expect(lock.kind).toBe('willSeal');
		expect(lock.tone).toBe('ok');
		expect(t(lock.summary)).toBe('This message will be sealed to a verified key');
		expect(render(lock.detail)).toBe(
			'Someone here has compared this key with its owner, so Owlat is encrypting to a key a person has checked — not only to the one it keeps seeing.'
		);
		// Verification strengthens the claim; it never opens a plaintext route.
		expect(lock.allowSendUnsealed).toBe(false);
	});

	it('never claims verification for a state that is not going to seal', () => {
		// The flag is a WORDING input on willSeal only: passing it with any other
		// state must change nothing, or the lock could promise a verified key on a
		// message that goes out in plaintext.
		const others: SealState[] = [
			{ kind: 'keyChanged', addresses: ['x@y.test'] },
			...(Object.keys(REASON_COPY) as SealSkipReason[]).map((reason): SealState => ({
				kind: 'cannotSeal',
				reason,
			})),
		];
		for (const state of others) {
			expect(deriveComposerLock(state, true)).toEqual(deriveComposerLock(state, false));
			expect(t(deriveComposerLock(state, true).summary)).not.toContain('verified');
		}
		expect(deriveComposerLock(null, true)).toEqual(deriveComposerLock(null, false));
	});

	it('"will be sealed" summary is UNREACHABLE for any non-willSeal state', () => {
		const nonWillSeal: SealState[] = [
			{ kind: 'keyChanged', addresses: ['x@y.test'] },
			...(Object.keys(REASON_COPY) as SealSkipReason[]).map((reason): SealState => ({
				kind: 'cannotSeal',
				reason,
			})),
		];
		for (const state of nonWillSeal) {
			expect(t(deriveComposerLock(state).summary)).not.toBe('This message will be sealed');
		}
	});
});

describe('sealSendBlock', () => {
	it('fails closed while state is loading and on an ordinary cannotSeal send', () => {
		expect(sealSendBlock(true, null, false)).toBe('checking');
		expect(sealSendBlock(true, { kind: 'cannotSeal', reason: 'recipient_no_key' }, false)).toBe(
			'needs_unsealed_consent'
		);
	});

	it('allows only the explicit unsealed action for cannotSeal', () => {
		expect(
			sealSendBlock(true, { kind: 'cannotSeal', reason: 'recipient_no_key' }, true)
		).toBeNull();
	});

	it('never bypasses keyChanged and stays inert when the feature is off', () => {
		const changed: SealState = { kind: 'keyChanged', addresses: ['eve@e.test'] };
		expect(sealSendBlock(true, changed, true)).toBe('key_changed');
		expect(sealSendBlock(false, changed, false)).toBeNull();
	});
});

describe('deriveUnsealedPrompt', () => {
	// Every reason the sender can act on states WHY it won't be sealed and WHAT
	// sending anyway means — the decision is never presented without its cost.
	const DECIDABLE: SealSkipReason[] = [
		'policy_off',
		'policy_ask',
		'recipient_no_key',
		'no_signing_key',
		'flag_off',
		'key_changed',
	];

	it.each(DECIDABLE)(
		'cannotSeal(%s) offers a proceed-or-cancel prompt with the reason',
		(reason) => {
			const prompt = deriveUnsealedPrompt({ kind: 'cannotSeal', reason });
			expect(prompt).not.toBeNull();
			expect(t(prompt!.title)).toBe('Send this message unsealed?');
			expect(t(prompt!.description)).toContain(
				'Owlat will send it as ordinary email, which the mail servers it passes through can read.'
			);
			// The reason clause comes first, so the prompt opens with the why.
			expect(t(prompt!.description).startsWith('Owlat will send it')).toBe(false);
			expect(t(prompt!.confirmLabel)).toBe('Send unsealed');
			expect(t(prompt!.cancelLabel)).toBe('Keep editing');
		}
	);

	it('verbatim reason clauses', () => {
		const describeReason = (reason: SealSkipReason) =>
			t(deriveUnsealedPrompt({ kind: 'cannotSeal', reason })!.description).split(
				' Owlat will send'
			)[0];
		expect(describeReason('policy_off')).toBe('Sealed mail is turned off for your workspace.');
		expect(describeReason('recipient_no_key')).toBe(
			"Some of your recipients can't receive sealed mail yet."
		);
		expect(describeReason('no_signing_key')).toBe(
			"The address you're sending from doesn't have a sealing key yet."
		);
		expect(describeReason('policy_ask')).toBe('Your workspace is set to ask before sealing.');
		expect(describeReason('flag_off')).toBe('Sealed mail is not available on this instance yet.');
		expect(describeReason('key_changed')).toBe("A recipient's key changed and still needs review.");
	});

	it('offers no prompt where plaintext is not the sender’s to choose', () => {
		expect(deriveUnsealedPrompt(null)).toBeNull();
		expect(deriveUnsealedPrompt({ kind: 'willSeal' })).toBeNull();
		expect(deriveUnsealedPrompt({ kind: 'keyChanged', addresses: ['bob@b.test'] })).toBeNull();
		expect(deriveUnsealedPrompt({ kind: 'cannotSeal', reason: 'no_recipients' })).toBeNull();
	});

	it('mirrors allowSendUnsealed exactly — every offered control has a prompt behind it', () => {
		const states: SealState[] = [
			{ kind: 'willSeal' },
			{ kind: 'keyChanged', addresses: ['bob@b.test'] },
			...(
				[
					'flag_off',
					'policy_off',
					'policy_ask',
					'no_recipients',
					'recipient_no_key',
					'key_changed',
					'no_signing_key',
				] as SealSkipReason[]
			).map((reason): SealState => ({ kind: 'cannotSeal', reason })),
		];
		for (const state of states) {
			expect(deriveUnsealedPrompt(state) !== null).toBe(
				deriveComposerLock(state).allowSendUnsealed
			);
		}
	});
});
