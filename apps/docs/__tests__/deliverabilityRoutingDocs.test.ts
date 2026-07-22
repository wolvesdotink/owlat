import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const guide = readRepoFile('apps/docs/content/1.guide/21.deliverability.md');
const providers = readRepoFile('apps/docs/content/3.developer/15.providers.md');
const infrastructure = readRepoFile(
	'apps/docs/content/3.developer/19.deliverability-infrastructure.md'
);

describe('deliverability routing documentation', () => {
	it('does not claim relay credentials or provisioning make a domain immediately eligible', () => {
		expect(guide).toMatch(/fallback stays off.*until both DNS and SES report it verified/i);
		expect(providers).toContain('Relay credentials are not DNS proof');
		expect(providers).toMatch(/future domains when they become verified/i);
	});

	it('documents one merged SPF, dedicated SES MAIL FROM, and unchanged primary DMARC', () => {
		expect(guide).toMatch(/one merged record authorizing both the owned MTA and SES/i);
		expect(guide).toMatch(/second `v=spf1` record would break SPF/i);
		expect(providers).toContain('`ses-mail` MAIL FROM');
		expect(providers).toMatch(/primary domain's DMARC remains authoritative/i);
	});

	it('names governed producers and the explicit system, Postbox, and SMTP exceptions', () => {
		for (const producer of ['campaign', 'automation', 'agent-reply', 'transactional', 'test']) {
			expect(infrastructure).toContain(producer);
		}
		expect(infrastructure).toMatch(/System\/auth mail and Postbox.*separate master-key-only/i);
		expect(infrastructure).toMatch(/raw SMTP submission.*does not participate/i);
		expect(infrastructure).toMatch(/changed or expired decision.*same idempotency key/i);
	});
});
