/**
 * Pure Sealed-Mail decision logic — `decideSeal` (dispatch-time) and
 * `deriveSealState` (composer-facing). No crypto, no db: exhaustive coverage of
 * the policy + all-recipients (D2) gates and the composer's three states.
 */

import { describe, it, expect } from 'vitest';
import {
	canSendWithSealState,
	decideSeal,
	deriveSealState,
	type RecipientKeyState,
	type SealInputs,
	type SealState,
} from '../sealPolicy';

const trusted = (address: string, key = `KEY:${address}`): RecipientKeyState => ({
	address,
	outcome: 'trusted',
	pinnedPublicKeyArmored: key,
});

const baseInputs = (over: Partial<SealInputs>): SealInputs => ({
	flagEnabled: true,
	policy: 'auto',
	hasSigningKey: true,
	recipients: [trusted('bob@b.test')],
	...over,
});

describe('mail/sealPolicy · decideSeal', () => {
	it('seals when auto + all recipients trusted + signer present', () => {
		const d = decideSeal(
			baseInputs({ recipients: [trusted('bob@b.test'), trusted('carol@c.test')] })
		);
		expect(d.seal).toBe(true);
		if (d.seal) {
			expect(d.recipientPublicKeysArmored).toEqual(['KEY:bob@b.test', 'KEY:carol@c.test']);
		}
	});

	it('never seals when the flag is off', () => {
		expect(decideSeal(baseInputs({ flagEnabled: false }))).toEqual({
			seal: false,
			reason: 'flag_off',
		});
	});

	it('never seals when the org policy is off', () => {
		expect(decideSeal(baseInputs({ policy: 'off' }))).toEqual({
			seal: false,
			reason: 'policy_off',
		});
	});

	it('does not auto-seal under the ask policy — it never seals automatically', () => {
		expect(decideSeal(baseInputs({ policy: 'ask' }))).toEqual({
			seal: false,
			reason: 'policy_ask',
		});
	});

	it('never seals with no recipients', () => {
		expect(decideSeal(baseInputs({ recipients: [] }))).toEqual({
			seal: false,
			reason: 'no_recipients',
		});
	});

	it('sends plaintext when ANY recipient lacks a usable key (D2 — no mixed send)', () => {
		const d = decideSeal(
			baseInputs({
				recipients: [trusted('bob@b.test'), { address: 'dave@d.test', outcome: 'notFound' }],
			})
		);
		expect(d).toEqual({ seal: false, reason: 'recipient_no_key' });
	});

	it('refuses to seal across an unsigned key change', () => {
		const d = decideSeal(
			baseInputs({
				recipients: [trusted('bob@b.test'), { address: 'eve@e.test', outcome: 'keyChanged' }],
			})
		);
		expect(d).toEqual({ seal: false, reason: 'key_changed' });
	});

	it('sends plaintext when the sender has no signing key', () => {
		expect(decideSeal(baseInputs({ hasSigningKey: false }))).toEqual({
			seal: false,
			reason: 'no_signing_key',
		});
	});
});

describe('mail/sealPolicy · deriveSealState (three states)', () => {
	it('willSeal — policy allows, every recipient is trusted, and the sender can sign', () => {
		expect(deriveSealState('auto', [trusted('bob@b.test'), trusted('carol@c.test')], true)).toEqual(
			{
				kind: 'willSeal',
			}
		);
	});

	it('keyChanged — surfaces the rotated addresses', () => {
		const state = deriveSealState(
			'auto',
			[trusted('bob@b.test'), { address: 'eve@e.test', outcome: 'keyChanged' }],
			true
		);
		expect(state).toEqual({ kind: 'keyChanged', addresses: ['eve@e.test'] });
	});

	it('cannotSeal — org policy off', () => {
		expect(deriveSealState('off', [trusted('bob@b.test')], true)).toEqual({
			kind: 'cannotSeal',
			reason: 'policy_off',
		});
	});

	it('cannotSeal — a recipient without a usable key', () => {
		expect(
			deriveSealState(
				'auto',
				[trusted('bob@b.test'), { address: 'dave@d.test', outcome: 'missing' }],
				true
			)
		).toEqual({ kind: 'cannotSeal', reason: 'recipient_no_key' });
	});

	it('cannotSeal — no recipients', () => {
		expect(deriveSealState('auto', [], true)).toEqual({
			kind: 'cannotSeal',
			reason: 'no_recipients',
		});
	});

	it('cannotSeal — sender has no signing key (mirrors decideSeal, no false promise)', () => {
		// All recipients trusted, policy auto, but the From address has no minted
		// key: the composer must NOT claim "will be sealed" when dispatch would send
		// plaintext with reason `no_signing_key`.
		expect(deriveSealState('auto', [trusted('bob@b.test')], false)).toEqual({
			kind: 'cannotSeal',
			reason: 'no_signing_key',
		});
	});

	it('cannotSeal — policy ask never promises sealing even when keys are ready', () => {
		// Keys present on both ends, but the org set `ask`: dispatch sends plaintext
		// with reason `policy_ask`, so the composer must report cannotSeal, not
		// willSeal — no per-message opt-in control exists to turn it on.
		expect(deriveSealState('ask', [trusted('bob@b.test')], true)).toEqual({
			kind: 'cannotSeal',
			reason: 'policy_ask',
		});
	});
});

describe('mail/sealPolicy · explicit plaintext consent', () => {
	it('allows normal Send only when the message will seal', () => {
		expect(canSendWithSealState({ kind: 'willSeal' }, false)).toBe(true);
		expect(canSendWithSealState({ kind: 'cannotSeal', reason: 'recipient_no_key' }, false)).toBe(
			false
		);
	});

	it('allows cannotSeal only through the explicit unsealed action', () => {
		expect(canSendWithSealState({ kind: 'cannotSeal', reason: 'recipient_no_key' }, true)).toBe(
			true
		);
	});

	it('never allows an unsigned key change, even with an override', () => {
		const changed: SealState = { kind: 'keyChanged', addresses: ['eve@e.test'] };
		expect(canSendWithSealState(changed, false)).toBe(false);
		expect(canSendWithSealState(changed, true)).toBe(false);
	});
});
