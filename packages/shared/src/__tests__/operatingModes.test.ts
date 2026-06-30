import { describe, it, expect } from 'vitest';
import { needsDeliveryProvider, resolveFlags } from '../featureFlags';
import {
	OPERATING_MODES,
	OPERATING_MODE_KEYS,
	operatingModeFlags,
	operatingModeNeedsTransport,
} from '../operatingModes';

describe('operatingModes — registry shape', () => {
	it('keys match the record', () => {
		for (const key of OPERATING_MODE_KEYS) {
			expect(OPERATING_MODES[key].key).toBe(key);
		}
		expect(OPERATING_MODE_KEYS).toEqual(Object.keys(OPERATING_MODES));
	});

	it('declared needsDeliveryProvider matches the resolved flag posture', () => {
		// This is the load-bearing consistency check: a preset cannot claim it
		// needs no provider while turning on a bulk sending flag (or vice-versa).
		for (const key of OPERATING_MODE_KEYS) {
			const computed = needsDeliveryProvider(operatingModeFlags(key));
			expect(computed, `${key}.needsDeliveryProvider drift`).toBe(OPERATING_MODES[key].needsDeliveryProvider);
		}
	});

	it('operatingModeFlags returns a dependency-consistent state', () => {
		for (const key of OPERATING_MODE_KEYS) {
			const flags = operatingModeFlags(key);
			// Idempotent through resolveFlags — no dangling requires violations.
			expect(resolveFlags(flags)).toEqual(flags);
		}
	});
});

describe('operatingModes — representative postures', () => {
	it('imap_only reads external mail and needs no delivery provider', () => {
		const flags = operatingModeFlags('imap_only');
		expect(flags['mail.external']).toBe(true);
		expect(flags.campaigns).toBe(false);
		expect(flags.transactional).toBe(false);
		expect(needsDeliveryProvider(flags)).toBe(false);
		expect(operatingModeNeedsTransport('imap_only')).toBe(false);
	});

	it('marketing turns on campaigns + automations + transactional and needs a provider', () => {
		const flags = operatingModeFlags('marketing');
		expect(flags.campaigns).toBe(true);
		expect(flags.automations).toBe(true);
		expect(flags.transactional).toBe(true);
		expect(needsDeliveryProvider(flags)).toBe(true);
	});

	it('hosted_mail needs the MTA as a transport even without bulk sending', () => {
		expect(OPERATING_MODES.hosted_mail.needsDeliveryProvider).toBe(false);
		expect(OPERATING_MODES.hosted_mail.needsMta).toBe(true);
		expect(operatingModeNeedsTransport('hosted_mail')).toBe(true);
	});

	it('team_inbox_ai enables the agent and an LLM-backed posture', () => {
		const flags = operatingModeFlags('team_inbox_ai');
		expect(flags.inbox).toBe(true);
		expect(flags.ai).toBe(true);
		expect(flags['ai.agent']).toBe(true);
		expect(operatingModeNeedsTransport('team_inbox_ai')).toBe(true);
	});

	it('crm_only sends nothing', () => {
		const flags = operatingModeFlags('crm_only');
		expect(needsDeliveryProvider(flags)).toBe(false);
		expect(operatingModeNeedsTransport('crm_only')).toBe(false);
	});

	it('full stack enables marketing + receiving + ai', () => {
		const flags = operatingModeFlags('full');
		const expectedOn = ['campaigns', 'transactional', 'automations', 'inbox', 'postbox', 'mail.external', 'ai', 'ai.agent'] as const;
		for (const f of expectedOn) {
			expect(flags[f], `full should enable ${f}`).toBe(true);
		}
	});
});
