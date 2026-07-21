import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const feedbackDoc = readRepoFile(
	'apps/docs/content/3.developer/37.external-reputation-feedback.md'
);
const delistingDoc = readRepoFile('apps/docs/content/3.developer/38.dnsbl-delisting.md');
const mtaEnv = readRepoFile('apps/mta/.env.example');
const postmasterCollector = readRepoFile('apps/mta/src/monitoring/postmaster.ts');
const postmasterApi = readRepoFile('apps/mta/src/monitoring/googlePostmasterApi.ts');
const dnsblPolicy = readRepoFile('packages/shared/src/dnsbl.ts');

describe('external reputation provider guidance', () => {
	it('documents the same supported Google OAuth keys and read-only scopes as the collector', () => {
		for (const key of [
			'GOOGLE_POSTMASTER_CLIENT_ID',
			'GOOGLE_POSTMASTER_CLIENT_SECRET',
			'GOOGLE_POSTMASTER_REFRESH_TOKEN',
		]) {
			expect(feedbackDoc).toContain(key);
			expect(mtaEnv).toContain(key);
		}
		expect(postmasterApi).toContain('postmaster.domain');
		expect(postmasterApi).toContain('postmaster.traffic.readonly');
		expect(postmasterApi).toContain('/v2');
		expect(postmasterCollector).toContain('domainStats:query');
		expect(postmasterCollector).not.toContain('/v1');
		expect(feedbackDoc).toMatch(/does\s+\*\*not\*\* expose.*domain-reputation.*IP-reputation/is);
		expect(feedbackDoc).toContain('v1-to-v2 migration guide');
		expect(feedbackDoc).not.toMatch(/service.account/i);
	});

	it('keeps Microsoft automation limitations explicit instead of promising a scraper', () => {
		expect(feedbackDoc).toMatch(/Automated Data Access/);
		expect(feedbackDoc).toMatch(/does not scrape|does not.*importer/i);
		expect(feedbackDoc).toMatch(/Junk Mail Reporting Program/);
	});
});

describe('DNSBL recovery runbooks', () => {
	it.each(['Spamhaus', 'Barracuda', 'SpamCop', 'Abusix'])(
		'has a deep-linkable %s runbook matching the shared list taxonomy',
		(listName) => {
			expect(delistingDoc).toMatch(new RegExp(`^## ${listName}$`, 'm'));
			expect(dnsblPolicy).toContain(`name: '${listName}'`);
		}
	);

	it('pins Spamhaus as the sole critical/eject provider', () => {
		expect(delistingDoc).toMatch(/quarantines.*only.*Spamhaus/i);
		const criticalDefinitions = dnsblPolicy.match(/severity: 'critical'/g) ?? [];
		expect(criticalDefinitions).toHaveLength(1);
	});
});
