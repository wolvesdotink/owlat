// @vitest-environment node
/**
 * The honesty audit for the reader's ONE trust chip.
 *
 * Five indicators collapsed into one chip (plan §05), which is exactly the
 * change that could quietly start claiming more than was checked: a green chip
 * over an unauthenticated sender, or an amber signal swallowed because a louder
 * driver won the label. Every case below pins one condition to one outcome.
 *
 * Pure module, so this needs no mounting and no i18n — `deriveTrustChip` hands
 * back catalog keys.
 */
import { describe, expect, it } from 'vitest';
import { deriveTrustChip, type TrustChipInput } from '../postboxTrustChip';

/** A message with nothing checked and nothing wrong: both flags on, no verdicts. */
function input(overrides: Partial<TrustChipInput> = {}): TrustChipInput {
	return {
		authEnabled: true,
		auth: {},
		sealedEnabled: true,
		secureClass: 'none',
		trackerPixels: 0,
		keyChanged: false,
		...overrides,
	};
}

/** DMARC pass on the From domain — the one shape that reads as verified. */
const VERIFIED = {
	fromDomain: 'northwind.studio',
	dmarcResult: 'pass',
	spfResult: 'pass',
	envelopeFromDomain: 'northwind.studio',
};

describe('deriveTrustChip — nothing to go on', () => {
	it('says "not checked" rather than green when no driver produced a verdict', () => {
		const chip = deriveTrustChip(input());
		expect(chip.tone).toBe('unknown');
		expect(chip.summary).toBe('components.postbox.postboxTrustChip.notChecked');
	});

	it('stays "not checked" when the flags are off, whatever the verdicts say', () => {
		const chip = deriveTrustChip(
			input({ authEnabled: false, sealedEnabled: false, auth: VERIFIED })
		);
		expect(chip.tone).toBe('unknown');
	});
});

describe('deriveTrustChip — the sender-authentication driver', () => {
	it('goes green on a verified sender', () => {
		const chip = deriveTrustChip(input({ auth: VERIFIED }));
		expect(chip.tone).toBe('ok');
		expect(chip.summary).toBe('shared.senderAuth.verified.summary');
	});

	it('names the failure rather than a generic warning', () => {
		const chip = deriveTrustChip(
			input({ auth: { fromDomain: 'northwind.studio', dmarcResult: 'fail' } })
		);
		expect(chip.tone).toBe('attention');
		expect(chip.summary).toBe('shared.senderAuth.failed.summary');
	});
});

describe('deriveTrustChip — driver priority', () => {
	it('lets the sealing record outrank the sender verdicts', () => {
		const chip = deriveTrustChip(
			input({
				auth: VERIFIED,
				sealed: { isSealed: true, isDecrypted: false },
			})
		);
		expect(chip.tone).toBe('attention');
		expect(chip.summary).toBe('shared.sealedMessage.cantDecrypt.summary');
	});

	it('ignores the sealing record when the sealedMail flag is off', () => {
		const chip = deriveTrustChip(
			input({
				sealedEnabled: false,
				auth: VERIFIED,
				sealed: { isSealed: true, isDecrypted: false },
			})
		);
		expect(chip.summary).toBe('shared.senderAuth.verified.summary');
	});

	it('reports ciphertext we never opened when no record explains it', () => {
		const chip = deriveTrustChip(input({ secureClass: 'pgp-encrypted' }));
		expect(chip.tone).toBe('attention');
		expect(chip.summary).toBe('components.postbox.postboxSecurityBadge.encrypted');
	});

	it('leaves a structurally signed message to the sender verdicts', () => {
		const chip = deriveTrustChip(input({ secureClass: 'pgp-signed', auth: VERIFIED }));
		expect(chip.tone).toBe('ok');
		expect(chip.summary).toBe('shared.senderAuth.verified.summary');
	});
});

describe('deriveTrustChip — escalations', () => {
	it('turns an otherwise-verified sender amber when tracking pixels were found', () => {
		const chip = deriveTrustChip(input({ auth: VERIFIED, trackerPixels: 3 }));
		expect(chip.tone).toBe('attention');
		expect(chip.summary).toBe('components.postbox.postboxTrustChip.worthALook');
	});

	it('turns it amber on an unsigned sealing-key rotation', () => {
		const chip = deriveTrustChip(input({ auth: VERIFIED, keyChanged: true }));
		expect(chip.tone).toBe('attention');
	});

	it('turns it amber when an impersonation heuristic fired', () => {
		const chip = deriveTrustChip(
			input({ auth: VERIFIED, heuristics: { lookalikeOfContactDomain: 'northwlnd.studio' } })
		);
		expect(chip.tone).toBe('attention');
	});

	it('drops those heuristics with the senderAuthBadges flag, like the badge does', () => {
		const chip = deriveTrustChip(
			input({ authEnabled: false, heuristics: { lookalikeOfContactDomain: 'northwlnd.studio' } })
		);
		expect(chip.tone).toBe('unknown');
	});

	it('keeps a named failure over the generic escalation copy', () => {
		const chip = deriveTrustChip(
			input({ auth: { fromDomain: 'northwind.studio', dmarcResult: 'fail' }, trackerPixels: 2 })
		);
		expect(chip.summary).toBe('shared.senderAuth.failed.summary');
	});
});
