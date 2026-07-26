import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), 'utf8');

const composeFiles = ['docker-compose.yml', 'infra/templates/docker-compose.vps.yml'];
const envFiles = [
	'.env.selfhost.example',
	'apps/mta/.env.example',
	'infra/templates/.env.vps.template',
];

describe('outbound IPv6 deployment policy', () => {
	it.each(composeFiles)('%s uses one explicit flag for MTA config and bridge plumbing', (path) => {
		const compose = read(path);
		expect(compose).toContain('MTA_IPV6_ENABLED: ${MTA_IPV6_ENABLED:-false}');
		expect(compose).toMatch(
			/default:\s*\n(?:\s*#.*\n)*\s*enable_ipv6: \$\{MTA_IPV6_ENABLED:-false\}/
		);
	});

	it.each(envFiles)('%s keeps the shipped install IPv4-only', (path) => {
		const env = read(path);
		expect(env).toMatch(/^MTA_IPV6_ENABLED=false$/m);
		for (const match of env.matchAll(/^IP_POOLS_(?:TRANSACTIONAL|CAMPAIGN)=(.+)$/gm)) {
			expect(match[1]).not.toContain(':');
		}
	});
});
