import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../env';
import { evaluateAcmeSidecar } from '../acmeSidecar';

const TEMPLATE = fileURLToPath(
	new URL('../../../../../infra/templates/.env.vps.template', import.meta.url)
);

const text = (env: Record<string, string>) =>
	evaluateAcmeSidecar(env).map((f) => ({
		ok: f.ok,
		message: String(f.message),
	}));

const configured = {
	ACME_DOMAIN: 'mail.acme.example.com',
	ACME_CONTACT_EMAIL: 'ops@example.com',
	LEGO_PROVIDER: 'hetzner',
	HETZNER_API_TOKEN: 'zone-token-value',
};

describe('doctor — acme sidecar', () => {
	it('says nothing on an install that runs no acme sidecar', () => {
		expect(evaluateAcmeSidecar({})).toEqual([]);
		expect(evaluateAcmeSidecar({ ACME_DOMAIN: 'mail.localhost' })).toEqual([]);
	});

	it('passes once it has a contact and a DNS token', () => {
		expect(text(configured)).toEqual([
			{ ok: true, message: expect.stringContaining('contact address and a DNS token') },
		]);
	});

	it('fails the template as shipped, naming both values the control plane fills', async () => {
		const env = await readEnv(TEMPLATE);
		expect(env['ACME_CONTACT_EMAIL']).toBe('{{ACME_CONTACT_EMAIL}}');
		expect(env['HETZNER_API_TOKEN']).toBe('{{ACME_DNS_API_TOKEN}}');
		const [finding] = text(env);
		expect(finding?.ok).toBe(false);
		expect(finding?.message).toContain('cannot issue the mail certificate');
		expect(finding?.message).toContain('ACME_CONTACT_EMAIL is not a reachable address');
		expect(finding?.message).toContain('HETZNER_API_TOKEN is empty or a placeholder');
	});

	it('fails an empty or localhost contact, and a provider whose token is not forwarded', () => {
		expect(text({ ...configured, ACME_CONTACT_EMAIL: '' })[0]?.ok).toBe(false);
		expect(text({ ...configured, ACME_CONTACT_EMAIL: 'admin@localhost' })[0]?.message).toContain(
			'@localhost'
		);
		const other = text({ ...configured, LEGO_PROVIDER: 'cloudflare' })[0];
		expect(other?.message).toContain('does not forward');
	});

	it('never prints the token', () => {
		const rendered = text({ ...configured, ACME_CONTACT_EMAIL: '' })
			.map((f) => f.message)
			.join('\n');
		expect(rendered).not.toContain('zone-token-value');
	});
});
