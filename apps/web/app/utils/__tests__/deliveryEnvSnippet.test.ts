import { describe, expect, it } from 'vitest';
import { buildDeliveryEnvSnippet } from '../deliveryEnvSnippet';

describe('buildDeliveryEnvSnippet', () => {
	it('emits one blank-valued line per missing var, in order', () => {
		expect(buildDeliveryEnvSnippet(['EMAIL_PROVIDER', 'RESEND_API_KEY'])).toBe(
			'EMAIL_PROVIDER=\nRESEND_API_KEY=',
		);
	});

	it('returns an empty string when nothing is missing', () => {
		expect(buildDeliveryEnvSnippet([])).toBe('');
	});

	it('never emits a value — every line ends at the "="', () => {
		const snippet = buildDeliveryEnvSnippet(['SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY']);
		for (const line of snippet.split('\n')) {
			expect(line).toMatch(/^[^=]+=$/);
		}
	});

	it('de-duplicates names and drops blank entries', () => {
		expect(buildDeliveryEnvSnippet(['EMAIL_PROVIDER', '', '  ', 'EMAIL_PROVIDER'])).toBe(
			'EMAIL_PROVIDER=',
		);
	});

	it('trims surrounding whitespace from names', () => {
		expect(buildDeliveryEnvSnippet([' EMAIL_PROVIDER '])).toBe('EMAIL_PROVIDER=');
	});
});
