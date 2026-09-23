import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH } from '@owlat/shared/passwordPolicy';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import { groupActiveFeatures, launchBlockers } from '../setupWizardReview';

const validAdmin = {
	email: 'admin@example.com',
	name: 'Ada',
	password: 'a'.repeat(MIN_PASSWORD_LENGTH),
};

function lookup(catalog: unknown, key: string): unknown {
	return key
		.split('.')
		.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog);
}

describe('groupActiveFeatures (#773)', () => {
	it('groups flags under their pack, in pack order, with the rest under "other"', () => {
		const active = [
			'campaigns.archive',
			'campaigns',
			'inbox',
			'ai.agent',
			'scan.content',
			'ai',
		] as FeatureFlagKey[];
		expect(groupActiveFeatures(active)).toEqual([
			{ pack: 'emailClient', flags: ['inbox'] },
			{ pack: 'marketing', flags: ['campaigns'] },
			{ pack: 'ai', flags: ['ai.agent', 'ai'] },
			{ pack: 'other', flags: ['campaigns.archive', 'scan.content'] },
		]);
	});

	it('drops empty groups', () => {
		expect(groupActiveFeatures([])).toEqual([]);
		expect(groupActiveFeatures(['campaigns'] as FeatureFlagKey[])).toEqual([
			{ pack: 'marketing', flags: ['campaigns'] },
		]);
	});
});

describe('launchBlockers (#773)', () => {
	it('is empty when everything is in place', () => {
		expect(
			launchBlockers({ missingProvider: false, admin: validAdmin, setupToken: 'stk_1' })
		).toEqual([]);
	});

	it('lists every blocker, each linked to where it is fixed', () => {
		const blockers = launchBlockers({
			missingProvider: true,
			admin: { email: '', name: '', password: '' },
			setupToken: '  ',
		});
		expect(blockers.map((b) => [b.id, b.to])).toEqual([
			['provider', '/setup/email'],
			['admin', '/setup/admin'],
			['token', '#setup-token'],
		]);
		for (const blocker of blockers) {
			expect(typeof lookup(en, blocker.message)).toBe('string');
			expect(typeof lookup(de, blocker.message)).toBe('string');
		}
	});

	it('blocks on an admin password under the shared minimum', () => {
		expect(
			launchBlockers({
				missingProvider: false,
				admin: { ...validAdmin, password: 'short' },
				setupToken: 'stk_1',
			}).map((b) => b.id)
		).toEqual(['admin']);
	});
});
