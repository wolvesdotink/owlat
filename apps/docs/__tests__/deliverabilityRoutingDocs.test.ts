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

	it('documents conditional SPF proof, dedicated SES MAIL FROM, and unchanged primary DMARC', () => {
		expect(guide).toMatch(/when an apex SPF row is displayed.*single reviewed merge/i);
		expect(guide).toMatch(/second `v=spf1` record would break SPF/i);
		expect(guide).toMatch(/if no apex SPF row is shown.*manual primary SPF unchanged/i);
		expect(guide).toMatch(/proof as not applicable to the SES relay/i);
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

	it('describes the standalone operator’s gate 2 as the rate PLUS the block clause above it', () => {
		// This is the reference page for the subsystem, and the bullet is phrased as
		// a description of the gate ROWS a standalone operator reads. Those rows come
		// from `ramp/trailingBaselineGates.ts`, where gate 2 is the deferral rate
		// with `evaluateSmtpBlockMessages` outranking it.
		//
		// IT SAID "DORMANT" UNTIL ISSUE #501 CLOSED, and that was true: the clause
		// had a reader and no producer, so a page naming it as part of what the
		// operator reads promised a halt no deployment could reach. What the page
		// must not do now is the opposite error — describing a halt without the two
		// things that decide whether it fires. So both are asserted: refusals are
		// NOT rate pressure (a page that conflated them would tell an operator their
		// cell halts for being throttled), and an unclassified window is ABSENT
		// rather than clean.
		expect(infrastructure).toMatch(
			/deferral is promoted to the primary fast signal — the deferral \*\*rate\*\*/
		);
		expect(infrastructure).toMatch(/\*\*outranking\*\* it/);
		expect(infrastructure).toContain('smtp.classified');
		expect(infrastructure).toMatch(/throttling and greylisting are rate pressure/i);
		expect(infrastructure).toMatch(/ABSENT rather than clean/);
		expect(infrastructure).toContain('issue #501');
		expect(infrastructure).not.toMatch(/and \*\*dormant\*\*/);
	});
});
