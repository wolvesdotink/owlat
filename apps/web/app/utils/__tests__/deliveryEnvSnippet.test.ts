import { describe, expect, it } from 'vitest';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared/sendProviderCatalog';
import {
	buildDeliveryEnvSnippet,
	buildEnvCliCommands,
	buildProviderEnvSkeleton,
	orderProviderEnvNames,
} from '../deliveryEnvSnippet';

describe('buildDeliveryEnvSnippet', () => {
	it('emits one blank-valued line per missing var, in order', () => {
		expect(buildDeliveryEnvSnippet(['EMAIL_PROVIDER', 'RESEND_API_KEY'])).toBe(
			'EMAIL_PROVIDER=\nRESEND_API_KEY='
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
			'EMAIL_PROVIDER='
		);
	});

	it('trims surrounding whitespace from names', () => {
		expect(buildDeliveryEnvSnippet([' EMAIL_PROVIDER '])).toBe('EMAIL_PROVIDER=');
	});
});

/**
 * The same skeleton, ORDERED BY THE ACTIVE KIND'S CATALOG ENTRY (the seams
 * plan's D1). The two lists are the same fact reached two ways — the status
 * query's `requiredEnv` is itself derived from the entry — so the pin worth
 * having is that neither direction can lose a variable: the entry decides the
 * ORDER, and anything the entry does not declare is still emitted rather than
 * dropped from a remedy an operator is about to paste.
 */
describe('buildProviderEnvSkeleton', () => {
	it.each(CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind))(
		'orders %s by the entry, whatever order the query answered in',
		(kind) => {
			const declared = CORE_SEND_PROVIDER_CATALOG_ENTRIES.find(
				(entry) => entry.kind === kind
			)!.requiredEnvVars;
			const shuffled = [...declared].reverse();
			expect(buildProviderEnvSkeleton(kind, shuffled)).toBe(
				declared.map((name) => `${name}=`).join('\n')
			);
		}
	);

	it('emits only the variables actually reported missing', () => {
		expect(buildProviderEnvSkeleton('ses', ['AWS_SES_SECRET_ACCESS_KEY'])).toBe(
			'AWS_SES_SECRET_ACCESS_KEY='
		);
		expect(buildProviderEnvSkeleton('ses', [])).toBe('');
	});

	it('still emits a reported name the entry does not declare, after the declared ones', () => {
		// Fail-OPEN on names, deliberately: this is a remedy list, and dropping a
		// variable the deployment genuinely needs would leave the operator pasting
		// a block that still cannot send.
		expect(buildProviderEnvSkeleton('resend', ['SES_SNS_TOPIC_ARN', 'RESEND_API_KEY'])).toBe(
			'RESEND_API_KEY=\nSES_SNS_TOPIC_ARN='
		);
	});

	it('falls back to the reported list whole for a transport this build does not carry', () => {
		expect(buildProviderEnvSkeleton('postmark', ['POSTMARK_TOKEN'])).toBe('POSTMARK_TOKEN=');
		expect(buildProviderEnvSkeleton(null, ['EMAIL_PROVIDER'])).toBe('EMAIL_PROVIDER=');
	});
});

describe('buildEnvCliCommands', () => {
	it('sets each variable with the owlat CLI, then restarts', () => {
		expect(buildEnvCliCommands(['MANDRILL_API_KEY'])).toBe(
			'owlat env MANDRILL_API_KEY <value>\nowlat restart'
		);
		expect(buildEnvCliCommands(['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID'])).toBe(
			'owlat env AWS_SES_REGION <value>\nowlat env AWS_SES_ACCESS_KEY_ID <value>\nowlat restart'
		);
	});

	it('is empty when there is nothing to set, so the block can hide', () => {
		expect(buildEnvCliCommands([])).toBe('');
		expect(buildEnvCliCommands(['', '  '])).toBe('');
	});

	it('de-duplicates and trims like the .env snippet', () => {
		expect(buildEnvCliCommands([' EMAIL_PROVIDER ', 'EMAIL_PROVIDER'])).toBe(
			'owlat env EMAIL_PROVIDER <value>\nowlat restart'
		);
	});

	it('never carries a value, only the placeholder', () => {
		for (const line of buildEnvCliCommands(['RESEND_API_KEY']).split('\n').slice(0, -1)) {
			expect(line).toMatch(/^owlat env [A-Z_]+ <value>$/);
		}
	});
});

describe('orderProviderEnvNames', () => {
	it('orders by the catalog entry and keeps undeclared names after', () => {
		expect(
			orderProviderEnvNames('ses', ['EXTRA_VAR', 'AWS_SES_SECRET_ACCESS_KEY', 'AWS_SES_REGION'])
		).toEqual(['AWS_SES_REGION', 'AWS_SES_SECRET_ACCESS_KEY', 'EXTRA_VAR']);
	});

	it('agrees with the skeleton it feeds', () => {
		const missing = ['AWS_SES_SECRET_ACCESS_KEY', 'AWS_SES_REGION'];
		expect(buildProviderEnvSkeleton('ses', missing)).toBe(
			orderProviderEnvNames('ses', missing)
				.map((name) => `${name}=`)
				.join('\n')
		);
	});
});
