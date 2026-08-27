/**
 * Per-recipient seal state on the composer chips (plan idea 11) — the honesty
 * audit for the presentational layer, as a test rather than a vibe.
 *
 * Three properties are pinned here:
 *   - a chip glyph speaks ONLY when the aggregate verdict turns on recipient
 *     keys, so a green lock never appears next to a message that an `off`/`ask`
 *     policy or a missing signing key is going to send in plaintext anyway;
 *   - the lock/no-key verdict follows the server's `hasUsableKey`, never the
 *     `outcome` alone — a `trusted` row without pinned material is keyless to
 *     dispatch, and the chip must agree; and
 *   - naming the blockers adds no route to plaintext: `deriveComposerLock` is
 *     unchanged by any of this, `keyChanged` never gets a remove button, and the
 *     unsealed prompt is still the only consent path.
 */
import { describe, it, expect } from 'vitest';
import { deriveComposerLock, deriveUnsealedPrompt, type SealState } from '../sealComposer';
import {
	findRecipientSealView,
	recipientSealGlyph,
	sealBlockingRecipients,
	showsRecipientSealGlyphs,
	type RecipientSealView,
} from '../sealRecipients';

const trusted = (address: string): RecipientSealView => ({
	address,
	outcome: 'trusted',
	hasUsableKey: true,
});
const keyless = (address: string): RecipientSealView => ({
	address,
	outcome: 'notFound',
	hasUsableKey: false,
});

const NO_KEY_STATE: SealState = { kind: 'cannotSeal', reason: 'recipient_no_key' };

describe('showsRecipientSealGlyphs', () => {
	it('says nothing before the state has been answered', () => {
		expect(showsRecipientSealGlyphs(null)).toBe(false);
	});

	it('speaks for the verdicts that turn on recipient keys', () => {
		expect(showsRecipientSealGlyphs({ kind: 'willSeal' })).toBe(true);
		expect(showsRecipientSealGlyphs({ kind: 'keyChanged', addresses: ['a@x.test'] })).toBe(true);
		expect(showsRecipientSealGlyphs(NO_KEY_STATE)).toBe(true);
	});

	it('stays silent when the block has nothing to do with the recipients', () => {
		for (const reason of ['flag_off', 'policy_off', 'policy_ask', 'no_signing_key'] as const) {
			expect(showsRecipientSealGlyphs({ kind: 'cannotSeal', reason })).toBe(false);
		}
	});

	it('stays silent when there are no recipients to mark', () => {
		expect(showsRecipientSealGlyphs({ kind: 'cannotSeal', reason: 'no_recipients' })).toBe(false);
	});
});

describe('recipientSealGlyph', () => {
	it('draws a lock only for a recipient with a usable key', () => {
		expect(recipientSealGlyph(trusted('ines@x.test'))).toMatchObject({
			kind: 'sealed',
			icon: 'lucide:lock',
			tone: 'ok',
		});
	});

	it('treats a trusted row WITHOUT pinned material as keyless, like dispatch does', () => {
		const glyph = recipientSealGlyph({
			address: 'mei@x.test',
			outcome: 'trusted',
			hasUsableKey: false,
		});
		expect(glyph.kind).toBe('noKey');
		expect(glyph.icon).toBe('lucide:lock-open');
	});

	it('marks a rotated key as its own warning, never as a lock', () => {
		const glyph = recipientSealGlyph({
			address: 'jonas@x.test',
			outcome: 'keyChanged',
			hasUsableKey: false,
		});
		expect(glyph).toMatchObject({ kind: 'keyChanged', tone: 'warn', icon: 'lucide:key-round' });
	});

	it('a rotated key outranks a still-usable one — the material is what is in doubt', () => {
		const glyph = recipientSealGlyph({
			address: 'jonas@x.test',
			outcome: 'keyChanged',
			hasUsableKey: true,
		});
		expect(glyph.kind).toBe('keyChanged');
	});

	it('names the recipient in every title it renders', () => {
		for (const view of [
			trusted('ines@x.test'),
			keyless('ines@x.test'),
			{ address: 'ines@x.test', outcome: 'keyChanged' as const, hasUsableKey: false },
		]) {
			const { title } = recipientSealGlyph(view);
			expect(typeof title).toBe('object');
			expect((title as { params?: Record<string, unknown> }).params).toEqual({
				address: 'ines@x.test',
			});
		}
	});
});

describe('findRecipientSealView', () => {
	const views = [trusted('Ines@Example.test')];

	it('matches a chip regardless of the case it was typed in', () => {
		expect(findRecipientSealView(views, 'ines@example.test')?.hasUsableKey).toBe(true);
		expect(findRecipientSealView(views, '  INES@EXAMPLE.TEST  ')?.hasUsableKey).toBe(true);
	});

	it('returns null for an address the server has not answered for yet', () => {
		expect(findRecipientSealView(views, 'someone-else@example.test')).toBeNull();
	});
});

describe('sealBlockingRecipients', () => {
	it('names exactly the recipients without a usable key', () => {
		expect(
			sealBlockingRecipients(NO_KEY_STATE, [
				trusted('ines@x.test'),
				trusted('mei@x.test'),
				keyless('jonas@acme.test'),
			])
		).toEqual(['jonas@acme.test']);
	});

	it('names every blocker, not just the first', () => {
		expect(
			sealBlockingRecipients(NO_KEY_STATE, [
				keyless('a@x.test'),
				trusted('b@x.test'),
				keyless('c@x.test'),
			])
		).toEqual(['a@x.test', 'c@x.test']);
	});

	it('offers no remove affordance for a rotated key — that is settled on the thread', () => {
		const state: SealState = { kind: 'keyChanged', addresses: ['jonas@acme.test'] };
		expect(sealBlockingRecipients(state, [keyless('jonas@acme.test')])).toEqual([]);
	});

	it('names nobody when the block is not about recipient keys', () => {
		for (const reason of [
			'flag_off',
			'policy_off',
			'policy_ask',
			'no_signing_key',
			'no_recipients',
		] as const) {
			expect(sealBlockingRecipients({ kind: 'cannotSeal', reason }, [keyless('a@x.test')])).toEqual(
				[]
			);
		}
	});

	it('names nobody for a draft that will seal, and nobody before the answer', () => {
		expect(sealBlockingRecipients({ kind: 'willSeal' }, [trusted('a@x.test')])).toEqual([]);
		expect(sealBlockingRecipients(null, [keyless('a@x.test')])).toEqual([]);
	});
});

describe('no-silent-downgrade guarantee', () => {
	it('leaves the composer lock derivation untouched for every state', () => {
		const states: Array<SealState | null> = [
			null,
			{ kind: 'willSeal' },
			{ kind: 'keyChanged', addresses: ['a@x.test'] },
			{ kind: 'cannotSeal', reason: 'flag_off' },
			{ kind: 'cannotSeal', reason: 'policy_off' },
			{ kind: 'cannotSeal', reason: 'policy_ask' },
			{ kind: 'cannotSeal', reason: 'no_recipients' },
			{ kind: 'cannotSeal', reason: 'recipient_no_key' },
			{ kind: 'cannotSeal', reason: 'key_changed' },
			{ kind: 'cannotSeal', reason: 'no_signing_key' },
		];
		for (const state of states) {
			const lock = deriveComposerLock(state);
			// Plaintext is offered by exactly the same states as before, and never
			// as a side effect of a recipient being named or removed.
			expect(lock.allowSendUnsealed).toBe(
				state?.kind === 'cannotSeal' && state.reason !== 'no_recipients'
			);
			// A lock that offers the control still has a prompt behind it.
			expect(!!deriveUnsealedPrompt(state)).toBe(lock.allowSendUnsealed);
		}
	});

	it('never names a blocker for a state that does not ask for plaintext consent', () => {
		const willSeal: SealState = { kind: 'willSeal' };
		expect(sealBlockingRecipients(willSeal, [trusted('a@x.test')])).toEqual([]);
		expect(deriveComposerLock(willSeal).allowSendUnsealed).toBe(false);
	});
});
