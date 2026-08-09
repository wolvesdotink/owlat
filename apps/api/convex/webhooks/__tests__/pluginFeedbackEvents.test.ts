import { describe, expect, it } from 'vitest';
import { parsePluginFeedbackEvents, PluginFeedbackEventError } from '../pluginFeedbackEvents';

const now = Date.now();

describe('portable provider feedback vocabulary', () => {
	it('maps every incumbent lifecycle and recipient-safety fact', () => {
		const events = parsePluginFeedbackEvents(
			[
				{ kind: 'sent', providerMessageId: 'm1', at: now },
				{ kind: 'failed', providerMessageId: 'm2', at: now, code: 'rejected' },
				{ kind: 'unsubscribed', recipient: 'left@example.com', at: now },
				{
					kind: 'provider_suppressed',
					recipient: 'blocked@example.com',
					reason: 'recipient_blacklisted',
					at: now,
				},
			],
			'plugin.acme.mail'
		);
		expect(events).toEqual([
			{
				kind: 'email.sent',
				providerMessageId: 'm1',
				at: now,
				providerType: 'plugin.acme.mail',
			},
			{
				kind: 'email.failed',
				providerMessageId: 'm2',
				at: now,
				errorCode: 'rejected',
				errorMessage: 'rejected',
				providerType: 'plugin.acme.mail',
			},
			{
				kind: 'email.unsubscribed',
				recipient: 'left@example.com',
				at: now,
				providerType: 'plugin.acme.mail',
			},
			{
				kind: 'email.provider_suppressed',
				recipient: 'blocked@example.com',
				reason: 'recipient_blacklisted',
				at: now,
				providerType: 'plugin.acme.mail',
			},
		]);
	});

	it('rejects a provider-defined suppression reason', () => {
		expect(() =>
			parsePluginFeedbackEvents(
				[
					{
						kind: 'provider_suppressed',
						recipient: 'victim@example.com',
						reason: 'account_problem',
						at: now,
					},
				],
				'plugin.acme.mail'
			)
		).toThrow(PluginFeedbackEventError);
	});
});
