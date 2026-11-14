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

describe('a plugin bounce names who it is about', () => {
	const bounce = (extra: Record<string, unknown>) =>
		parsePluginFeedbackEvents(
			[{ kind: 'bounced', providerMessageId: 'm1', at: now, bounceType: 'hard', ...extra }],
			'plugin.acme.mail'
		);

	it.each(['sender', 'recipient'] as const)('carries bounceCause %s to the lifecycle', (cause) => {
		expect(bounce({ bounceCause: cause })).toEqual([
			{
				kind: 'email.bounced',
				providerMessageId: 'm1',
				at: now,
				bounceType: 'hard',
				bounceCause: cause,
				providerType: 'plugin.acme.mail',
			},
		]);
	});

	it('leaves the cause out when the plugin names none, which keeps the recipient', () => {
		expect(bounce({})[0]).not.toHaveProperty('bounceCause');
	});

	it('refuses a cause outside the vocabulary', () => {
		expect(() => bounce({ bounceCause: 'provider' })).toThrow(PluginFeedbackEventError);
	});
});
