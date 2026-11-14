/**
 * Whether the VPS template's `acme` sidecar can obtain the mail host's
 * certificate (`infra/templates/docker-compose.vps.yml`, personal-mail
 * profile; `infra/templates/acme-entrypoint.sh`).
 *
 * `ACME_DOMAIN` configures it. It then needs a contact address Let's Encrypt
 * accepts and a DNS token for its DNS-01 challenge, and without them it fails
 * every attempt while IMAP and inbound SMTP keep serving the self-signed
 * certificate, which mail clients reject. A `{{PLACEHOLDER}}` the control plane
 * did not fill counts as missing. The root `docker-compose.yml` runs no such
 * sidecar, so an install without `ACME_DOMAIN` is not checked.
 */

import type { DoctorFinding } from './doctorReport';
import { doctorText, trusted } from './doctorText';
import type { EnvMap } from './env';
import { isValidEmail } from './validators';

/** The compose file's fallback for an unset `ACME_DOMAIN`, which names no real host. */
const UNSET_DOMAIN = 'mail.localhost';

/** The one provider whose credential the acme service forwards. */
const FORWARDED_PROVIDER = 'hetzner';

function filled(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text && !/\{\{.*\}\}/.test(text) ? text : undefined;
}

export function evaluateAcmeSidecar(env: EnvMap): DoctorFinding[] {
	const domain = env['ACME_DOMAIN']?.trim();
	if (!domain || domain === UNSET_DOMAIN) return [];

	const problems: string[] = [];
	const contact = filled(env['ACME_CONTACT_EMAIL']);
	if (!contact || !isValidEmail(contact) || contact.toLowerCase().endsWith('@localhost')) {
		problems.push(
			'ACME_CONTACT_EMAIL is not a reachable address (empty, a placeholder, or @localhost, which Let’s Encrypt refuses)'
		);
	}
	const provider = env['LEGO_PROVIDER']?.trim() || FORWARDED_PROVIDER;
	if (provider !== FORWARDED_PROVIDER) {
		problems.push(
			'LEGO_PROVIDER names a provider whose credential the acme service does not forward; add its variable to the acme service'
		);
	} else if (!filled(env['HETZNER_API_TOKEN'])) {
		problems.push(
			'HETZNER_API_TOKEN is empty or a placeholder; set a Hetzner DNS token that can edit the zone of ACME_DOMAIN'
		);
	}

	if (problems.length === 0) {
		return [
			{
				check: 'env.acme',
				ok: true,
				message: doctorText`the acme sidecar has a contact address and a DNS token for ${trusted('ACME_DOMAIN')}`,
			},
		];
	}
	return [
		{
			check: 'env.acme',
			ok: false,
			message: doctorText`the acme sidecar cannot issue the mail certificate, so IMAP and inbound SMTP keep the self-signed one: ${trusted(problems.join('; '))}. Then run ${trusted('docker compose --profile personal-mail up -d acme')}.`,
		},
	];
}
