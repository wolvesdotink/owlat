import { describe, it, expect } from 'vitest';
import { deriveOstrChip } from '../ostrChip';
import { createTestI18n, localizedWith } from '~/__tests__/i18n';

const { t } = createTestI18n().global;
const localized = localizedWith(t);

describe('deriveOstrChip', () => {
	it('maps each speaking tier to its tone and its catalog keys', () => {
		expect(deriveOstrChip('establishing')).toEqual({
			labelKey: 'shared.ostr.tier.establishing.label',
			detailKey: 'shared.ostr.tier.establishing.detail',
			tone: 'neutral',
		});
		expect(deriveOstrChip('trusted')?.tone).toBe('ok');
		expect(deriveOstrChip('warned')?.tone).toBe('warn');
		expect(deriveOstrChip('flagged')?.tone).toBe('danger');
	});

	it('separates a short clean history from a sustained one', () => {
		// The two differ on strength of evidence, so they must not share a tone:
		// `trusted` is the only tier that earns the reassuring one.
		expect(deriveOstrChip('establishing')?.tone).not.toBe(deriveOstrChip('trusted')?.tone);
	});

	it('renders real copy for every tier, never a bare key', () => {
		for (const tier of ['establishing', 'trusted', 'warned', 'flagged']) {
			const chip = deriveOstrChip(tier)!;
			expect(t(chip.labelKey)).not.toBe(chip.labelKey);
			expect(t(chip.detailKey)).not.toBe(chip.detailKey);
		}
	});

	it('says nothing when the registry knows nothing', () => {
		expect(deriveOstrChip(undefined)).toBeNull();
		expect(deriveOstrChip('unknown')).toBeNull();
		expect(deriveOstrChip('')).toBeNull();
	});

	it('says nothing for a tier this build does not know', () => {
		// A newer MTA could persist a tier a shipped client has no copy for; a
		// chip it cannot explain is worse than no chip.
		expect(deriveOstrChip('quarantined')).toBeNull();
		// Including the inherited names an object-literal lookup table would
		// answer to: those would mint a chip whose label key has no copy, and the
		// reader would be shown the raw key path.
		expect(deriveOstrChip('constructor')).toBeNull();
		expect(deriveOstrChip('__proto__')).toBeNull();
		expect(deriveOstrChip('toString')).toBeNull();
		expect(deriveOstrChip('hasOwnProperty')).toBeNull();
	});

	it('accepts the tier as persisted, whatever its casing or padding', () => {
		expect(deriveOstrChip('  Trusted ')?.tone).toBe('ok');
	});
});
