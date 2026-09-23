import { describe, expect, it } from 'vitest';
import { needsDeliveryProvider, resolveFlags } from '@owlat/shared/featureFlags';
import { operatingModeFlags } from '@owlat/shared/operatingModes';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import {
	DEFAULT_SETUP_OUTCOME,
	SETUP_OUTCOMES,
	outcomeAnswersEmail,
	outcomeFlags,
} from '../setupWizardOutcomes';

function lookup(catalog: unknown, key: string): unknown {
	return key
		.split('.')
		.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog);
}

describe('setup outcomes (#770)', () => {
	it('asks three questions and recommends "Both"', () => {
		expect(SETUP_OUTCOMES.map((o) => o.key)).toEqual(['conversations', 'sending', 'both']);
		expect(DEFAULT_SETUP_OUTCOME).toBe('both');
	});

	it('words every outcome in both catalogs', () => {
		for (const option of SETUP_OUTCOMES) {
			for (const key of [option.label, option.description]) {
				expect(typeof lookup(en, key)).toBe('string');
				expect(typeof lookup(de, key)).toBe('string');
			}
		}
	});

	it('maps "answer email together" to the team inbox preset', () => {
		expect(outcomeFlags('conversations', false)).toEqual(
			resolveFlags(operatingModeFlags('team_inbox'))
		);
		expect(outcomeFlags('conversations', true)).toEqual(
			resolveFlags(operatingModeFlags('team_inbox_ai'))
		);
	});

	it('maps "newsletters and automated email" to the marketing preset and ignores AI drafts', () => {
		expect(outcomeFlags('sending', false)).toEqual(resolveFlags(operatingModeFlags('marketing')));
		expect(outcomeFlags('sending', true)).toEqual(outcomeFlags('sending', false));
		expect(outcomeAnswersEmail('sending')).toBe(false);
	});

	it('turns on both halves for "Both"', () => {
		const flags = outcomeFlags('both', false);
		for (const key of ['inbox', 'campaigns', 'automations', 'transactional'] as const) {
			expect(flags[key]).toBe(true);
		}
		expect(flags['ai.agent']).toBe(false);
		expect(outcomeFlags('both', true)['ai.agent']).toBe(true);
		expect(needsDeliveryProvider(flags)).toBe(true);
	});
});
