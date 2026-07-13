/**
 * Composer-lock derivation honesty audit (Sealed Mail E5). Every reachable
 * string maps 1:1 to a `sealState`; `willSeal` is the ONLY state that promises
 * encryption, and only `cannotSeal` permits an explicit unsealed send.
 */
import { describe, it, expect } from 'vitest';
import { deriveComposerLock, type SealSkipReason, type SealState } from '../sealComposer';

describe('deriveComposerLock', () => {
	it('willSeal: verbatim promise copy, ok tone, no unsealed escape hatch', () => {
		const lock = deriveComposerLock({ kind: 'willSeal' });
		expect(lock.kind).toBe('willSeal');
		expect(lock.summary).toBe('This message will be sealed');
		expect(lock.detail).toBe(
			'Everyone you are writing to can receive sealed mail, so Owlat will encrypt this message before it leaves your workspace.'
		);
		expect(lock.tone).toBe('ok');
		expect(lock.allowSendUnsealed).toBe(false);
	});

	it('keyChanged: verbatim copy names the rotated recipients, warn tone, no silent send', () => {
		const lock = deriveComposerLock({ kind: 'keyChanged', addresses: ['bob@b.test'] });
		expect(lock.kind).toBe('keyChanged');
		expect(lock.summary).toBe("A recipient's key changed");
		expect(lock.detail).toBe(
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
		expect(lock.detail).toContain('bob@b.test and carol@c.test');
	});

	it('cannotSeal: muted tone, and sending unsealed is an EXPLICIT act', () => {
		const lock = deriveComposerLock({ kind: 'cannotSeal', reason: 'recipient_no_key' });
		expect(lock.kind).toBe('cannotSeal');
		expect(lock.summary).toBe("This message won't be sealed");
		expect(lock.tone).toBe('muted');
		expect(lock.allowSendUnsealed).toBe(true);
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
			expect(lock.detail).toBe(REASON_COPY[reason]);
			// No cannotSeal state may ever read as a sealing promise.
			expect(lock.summary).not.toContain('will be sealed');
		}
	);

	it('"will be sealed" summary is UNREACHABLE for any non-willSeal state', () => {
		const nonWillSeal: SealState[] = [
			{ kind: 'keyChanged', addresses: ['x@y.test'] },
			...(Object.keys(REASON_COPY) as SealSkipReason[]).map(
				(reason): SealState => ({ kind: 'cannotSeal', reason })
			),
		];
		for (const state of nonWillSeal) {
			expect(deriveComposerLock(state).summary).not.toBe('This message will be sealed');
		}
	});
});
