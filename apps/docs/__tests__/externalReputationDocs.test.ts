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

	it('documents the SNDS import against the Automated Data Access contract', () => {
		// The page previously promised NO importer, because Microsoft's July 2026
		// portal change left no stable URL to point at. The operator now supplies
		// the Automated Data Access URL themselves, so the importer is documented
		// — including the one thing it must never do (invent a rate from a band).
		expect(feedbackDoc).toMatch(/Automated Data Access/);
		expect(feedbackDoc).toContain('SNDS_DATA_FEED_URLS');
		expect(feedbackDoc).toMatch(/bearer capability/i);
		expect(feedbackDoc).toMatch(/band/i);
		expect(feedbackDoc).toMatch(/never turned into|not a rate/i);
		expect(feedbackDoc).toMatch(/Junk Mail Reporting Program/);
	});

	it('states that Microsoft enrollment is optional, not an incomplete setup', () => {
		expect(feedbackDoc).toMatch(/supported configuration/i);
		expect(feedbackDoc).toMatch(/no request,\s+no row,\s+no error/i);
		// The substitution the page names has to be the one the table applies
		// (`ramp/degradationMatrix.ts`, the `microsoft_snds` entry). It said "SMTP
		// reply classification" until issue #501 established that no deployment
		// carried those categories into Convex. They do now — and the entry still
		// may not name it, because the clause that reads them belongs to the
		// standalone evaluator while this substitution covers relay-equipped cells
		// too. A page promising a signal half the cells it describes never consult
		// is the same defect, on a smaller share of deployments.
		expect(feedbackDoc).toMatch(/outcomes of\s+its own sends/i);
		expect(feedbackDoc).not.toMatch(/SMTP reply\s+classification/i);
	});

	it('states that unattributed evidence can only slow the Microsoft ramp', () => {
		// The asymmetry is the whole point of the attribution flag, so the page
		// states both halves: an unattributed clean window HOLDS, and a breach in
		// the same window still fails.
		expect(feedbackDoc).toMatch(/\*holds\*\s+rather than passing/i);
		expect(feedbackDoc).toMatch(/slowing the ramp and can never speed it up/i);
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
