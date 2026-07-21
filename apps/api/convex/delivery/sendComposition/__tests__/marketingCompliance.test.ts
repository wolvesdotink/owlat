import { describe, expect, it } from 'vitest';
import { SIGNED_HEADERS } from '@owlat/mail-message';
import { assertMarketingOneClickHeaders } from '../../marketingCompliance';

const RFC8058_HEADERS = {
	'List-Unsubscribe': '<https://example.test/unsub/token>',
	'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};

describe('assertMarketingOneClickHeaders', () => {
	it('accepts a marketing envelope only when both RFC 8058 headers are present and signed', () => {
		expect(() => assertMarketingOneClickHeaders('marketing', RFC8058_HEADERS)).not.toThrow();
		expect(SIGNED_HEADERS).toContain('list-unsubscribe');
		expect(SIGNED_HEADERS).toContain('list-unsubscribe-post');
	});

	it.each(['List-Unsubscribe', 'List-Unsubscribe-Post'] as const)(
		'refuses a marketing envelope missing %s',
		(missingHeader) => {
			const headers = { ...RFC8058_HEADERS };
			delete headers[missingHeader];
			expect(() => assertMarketingOneClickHeaders('marketing', headers)).toThrow(
				missingHeader.toLowerCase()
			);
		}
	);

	it('refuses headers that are present but do not describe an RFC 8058 one-click target', () => {
		expect(() =>
			assertMarketingOneClickHeaders('marketing', {
				'List-Unsubscribe': '<mailto:unsubscribe@example.test>',
				'List-Unsubscribe-Post': 'not-one-click',
			})
		).toThrow('valid RFC 8058');
	});

	it('does not impose marketing headers on transactional mail', () => {
		expect(() => assertMarketingOneClickHeaders('transactional', {})).not.toThrow();
	});
});
