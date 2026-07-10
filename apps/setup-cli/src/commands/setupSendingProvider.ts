/**
 * Terminal-wizard picker for the instance-level outbound transport.
 *
 * One deployment sends through exactly one transport: its own MTA, Amazon SES,
 * a generic SMTP relay (Mailgun / Postmark / SendGrid / Brevo / custom — every
 * one speaks plain SMTP submission, so a single set of `SMTP_RELAY_*` env vars
 * drives them all), or Resend. Extracted from `setup.ts` so that file stays
 * focused and under the size ratchet; the web wizard's equivalent lives in
 * `apps/web/app/pages/setup/email.vue`.
 *
 * Credential-bearing choices are validated for real before they are persisted
 * (Resend key request, SMTP handshake + AUTH), so an operator finds a bad
 * host/port/credential here rather than at first send.
 */

import { select, password, text, confirm, group, isCancel } from '@clack/prompts';
import { validateWithSpinner } from '../lib/progress';
import { type EnvMap } from '../lib/env';
import { validateResendKey, validateSmtpRelay } from '../lib/validators';
import { SMTP_RELAY_PRESETS, type SmtpRelayPreset } from '@owlat/shared/setupSendingPresets';

/** A relay port is optional (backend defaults to 587), but if given must parse
 * to a real port — mirrors the web step's `isValidSmtpPort`. Returns an error
 * string for clack's `validate:` when invalid. */
function validatePortInput(value: string | undefined): string | undefined {
	const trimmed = (value ?? '').trim();
	if (trimmed === '') return undefined;
	if (!/^\d+$/.test(trimmed)) return 'Port must be digits only (leave blank for 587).';
	const n = Number.parseInt(trimmed, 10);
	if (n < 1 || n > 65535) return 'Port must be between 1 and 65535.';
	return undefined;
}

/** Reject an empty required field at the prompt instead of deferring to the
 * network probe (matches the web step, which blocks empty fields client-side). */
function requireNonEmpty(label: string): (value: string | undefined) => string | undefined {
	return (value) => ((value ?? '').trim() === '' ? `${label} is required.` : undefined);
}

export async function pickSendingProvider(): Promise<EnvMap | null> {
	const provider = await select({
		message: 'Email sending provider',
		options: [
			{ label: 'Run your own MTA (self-hosted)', value: 'mta', hint: 'no third-party' },
			{ label: 'Amazon SES', value: 'ses', hint: 'managed, needs an AWS account' },
			{
				label: 'SMTP relay',
				value: 'smtp',
				hint: 'Mailgun / Postmark / SendGrid / Brevo / custom',
			},
			{ label: 'Resend', value: 'resend', hint: 'managed API' },
		],
	});
	if (isCancel(provider)) return null;

	if (provider === 'mta') {
		return { EMAIL_PROVIDER: 'mta' };
	}

	if (provider === 'resend') {
		const apiKey = await password({ message: 'Resend API key (re_...)' });
		if (isCancel(apiKey)) return null;
		if (
			!(await validateWithSpinner('Validating Resend key', () =>
				validateResendKey(apiKey as string)
			))
		) {
			return null;
		}
		return { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: apiKey as string };
	}

	if (provider === 'ses') {
		const result = await group({
			region: () => text({ message: 'AWS SES region', placeholder: 'us-east-1' }),
			accessKey: () => password({ message: 'AWS_ACCESS_KEY_ID' }),
			secretKey: () => password({ message: 'AWS_SECRET_ACCESS_KEY' }),
		});
		return {
			EMAIL_PROVIDER: 'ses',
			AWS_SES_REGION: result.region,
			AWS_SES_ACCESS_KEY_ID: result.accessKey,
			AWS_SES_SECRET_ACCESS_KEY: result.secretKey,
		};
	}

	if (provider === 'smtp') {
		const preset = await select({
			message: 'SMTP relay provider',
			options: (Object.keys(SMTP_RELAY_PRESETS) as SmtpRelayPreset[]).map((key) => ({
				label: SMTP_RELAY_PRESETS[key].label,
				value: key,
			})),
		});
		if (isCancel(preset)) return null;
		const defaults = SMTP_RELAY_PRESETS[preset];

		const result = await group({
			host: () =>
				text({
					message: 'SMTP host',
					placeholder: defaults.host || 'smtp.example.com',
					initialValue: defaults.host,
					validate: requireNonEmpty('SMTP host'),
				}),
			port: () =>
				text({
					message: 'SMTP port',
					placeholder: '587',
					initialValue: defaults.port,
					validate: validatePortInput,
				}),
			secure: () =>
				confirm({
					message: 'Use implicit TLS (port 465)? No = STARTTLS on 587',
					initialValue: defaults.secure,
				}),
			username: () =>
				text({ message: 'SMTP username', validate: requireNonEmpty('SMTP username') }),
			password: () =>
				password({ message: 'SMTP password', validate: requireNonEmpty('SMTP password') }),
		});

		// The port that gets validated is the port that gets persisted: the prompt
		// already guaranteed digits in range (or blank ⇒ 587), so parse once and
		// reuse the same number for both the handshake and the env value.
		const trimmedPort = result.port.trim();
		const port = trimmedPort === '' ? 587 : Number.parseInt(trimmedPort, 10);

		const ok = await validateWithSpinner('Validating SMTP relay', () =>
			validateSmtpRelay({
				host: result.host,
				port,
				secure: result.secure,
				username: result.username,
				password: result.password,
			})
		);
		if (!ok) return null;

		// Always write the port. setup.ts applies this patch with
		// mergeEnv(existing, patch) = { ...existing, ...patch }, and re-running
		// setup over an existing install is supported — omitting the key on the
		// default would let a stale SMTP_RELAY_PORT (e.g. 465) survive and diverge
		// from the port the handshake just validated.
		return {
			EMAIL_PROVIDER: 'smtp',
			SMTP_RELAY_HOST: result.host,
			SMTP_RELAY_PORT: String(port),
			SMTP_RELAY_USERNAME: result.username,
			SMTP_RELAY_PASSWORD: result.password,
			SMTP_RELAY_SECURE: result.secure ? 'true' : 'false',
		};
	}

	return null;
}
