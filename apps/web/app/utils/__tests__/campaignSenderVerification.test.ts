import { describe, it, expect } from 'vitest';
import { mapSenderVerification, type SenderDomainStatus } from '../campaignSenderVerification';
import { createTestI18n, localizedWith } from '~/__tests__/i18n';

/**
 * The advisory is a framework-free module, so it carries catalog keys rather
 * than sentences. Rendering them through the real English catalog keeps these
 * assertions on the copy a person reads.
 */
const { t } = createTestI18n().global;
const render = localizedWith(t);

const verified: SenderDomainStatus = {
	domain: 'acme.com',
	exists: true,
	verified: true,
	stale: false,
};

describe('mapSenderVerification', () => {
	it('prompts and blocks add when the email is not valid yet', () => {
		const result = mapSenderVerification(verified, false);
		expect(render(result.message)).toBe(
			'Enter an address on one of your verified sending domains.'
		);
		expect(result.tone).toBe('neutral');
		expect(result.canAdd).toBe(false);
		expect(result.showDomainsLink).toBe(false);
	});

	it('shows a checking state while the status has not loaded', () => {
		const result = mapSenderVerification(undefined, true);
		expect(result.tone).toBe('neutral');
		expect(result.canAdd).toBe(false);
	});

	it('warns and blocks add when the domain check fails', () => {
		const result = mapSenderVerification(undefined, true, true);
		expect(result.tone).toBe('warning');
		expect(result.canAdd).toBe(false);
		expect(result.showDomainsLink).toBe(false);
		expect(render(result.message)).toContain('try again');
	});

	it('warns and links to Domains when the domain is not registered', () => {
		const result = mapSenderVerification(
			{ domain: 'acme.com', exists: false, verified: false, stale: false },
			true
		);
		expect(result.tone).toBe('warning');
		expect(result.canAdd).toBe(false);
		expect(result.showDomainsLink).toBe(true);
		expect(render(result.message)).toContain('acme.com');
	});

	it('warns and links to Domains when registered but unverified', () => {
		const result = mapSenderVerification(
			{ domain: 'acme.com', exists: true, verified: false, stale: false },
			true
		);
		expect(result.tone).toBe('warning');
		expect(result.canAdd).toBe(false);
		expect(result.showDomainsLink).toBe(true);
	});

	it('allows add on a verified domain', () => {
		const result = mapSenderVerification(verified, true);
		expect(result.tone).toBe('success');
		expect(result.canAdd).toBe(true);
		expect(result.showDomainsLink).toBe(false);
		expect(render(result.message)).toBe('"acme.com" is verified — you can add this sender.');
	});

	it('still allows add when a verified domain is stale', () => {
		const result = mapSenderVerification({ ...verified, stale: true }, true);
		expect(result.canAdd).toBe(true);
		expect(result.tone).toBe('success');
	});
});
