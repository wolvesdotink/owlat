/**
 * The shipped compose files give the MTA a fixed `environment:` map and no
 * `env_file`, so a variable the map leaves out never reaches the container. An
 * operator sets it in `.env`, the backend and the transport editor report it,
 * and the MTA quietly runs on its built-in default instead.
 *
 * The read set is taken from the MTA source by apps/mta/scripts/envReads.ts,
 * the same scan the MTA's env-example lint uses. Each compose file must
 * forward all of them, with the MTA's own default where the source states a
 * literal one, so that an unset variable behaves the same with or without
 * compose in between.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
	REPOSITORY_ROOT,
	UPPER_LITERAL,
	mtaCodeDefaults,
	mtaEnvReads,
	mtaSourceFiles,
	undocumentedReads,
} from '@owlat/mta/scripts/envReads';

const COMPOSE_FILES = ['docker-compose.yml', 'infra/templates/docker-compose.vps.yml'] as const;

/** Read by the MTA but deliberately left out of the compose files. */
const NOT_FORWARDED: Record<string, string> = {
	MTA_SERVER_ID:
		'defaults to the container hostname; compose cannot leave a key unset, and an empty value would replace that default',
	MTA_ALLOW_PRIVATE_MX:
		'turns off the screening of loopback and private MX targets for a lab stack; a production install must not be able to switch it on from .env, so an operator adds it to the service by hand',
};

/** `${NAME}`, `${NAME-default}` or `${NAME:-default}`; `${NAME:?}` is required, so has none. */
const DEFAULTED = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-(.*))?\}$/s;

const SOURCES = mtaSourceFiles();

function mtaEnvironment(file: string): Record<string, unknown> {
	const compose = parse(readFileSync(join(REPOSITORY_ROOT, file), 'utf8')) as {
		services: { mta: { environment: Record<string, unknown> } };
	};
	return compose.services.mta.environment;
}

const READS = mtaEnvReads(SOURCES);

describe('MTA environment reads', () => {
	it('finds a read of every shape the MTA uses', () => {
		for (const name of [
			'EHLO_HOSTNAME',
			'OUTBOUND_TLS_MODE',
			'SMTP_POOL_MAX_PER_HOST',
			'DANE_MODE',
			'WEBHOOK_DLQ_MAX_SIZE',
			'BOUNCE_TLS_CERT_FILE',
			'TLS_CERT_DIR',
			'MTA_IPV6_ENABLED',
			'LOG_LEVEL',
		]) {
			expect(READS.has(name), name).toBe(true);
		}
	});

	it('leaves no variable name in an env-reading module unrecognised', () => {
		const unrecognised: string[] = [];
		for (const { path, text } of SOURCES) {
			if (![...READS.values()].some((files) => files.includes(path))) continue;
			for (const match of text.matchAll(UPPER_LITERAL)) {
				if (!READS.has(match[1]!)) unrecognised.push(`${path}: ${match[1]}`);
			}
		}
		expect(
			unrecognised,
			'a new read shape: teach READ_SHAPES in this file to recognise it'
		).toEqual([]);
	});

	it('gives the env-example lint the same reads, intEnv included', () => {
		const reads = mtaEnvReads([
			{ path: 'apps/mta/src/newLimit.ts', text: "const limit = intEnv('NEW_SEND_LIMIT', 5);" },
		]);
		expect(undocumentedReads(reads, 'PORT=3100\n# OTHER_LIMIT=1\n')).toEqual(['NEW_SEND_LIMIT']);
		expect(undocumentedReads(reads, '# NEW_SEND_LIMIT=5\n')).toEqual([]);
	});

	it('lists only variables the MTA still reads as deliberately not forwarded', () => {
		expect(Object.keys(NOT_FORWARDED).filter((name) => !READS.has(name))).toEqual([]);
	});
});

describe.each(COMPOSE_FILES)('%s mta service', (file) => {
	const environment = mtaEnvironment(file);

	it('forwards every variable the MTA reads', () => {
		const missing = [...READS.keys()]
			.filter((name) => !(name in environment) && !(name in NOT_FORWARDED))
			.sort();
		expect(missing, `add these to the mta environment in ${file}`).toEqual([]);
	});

	it('leaves out the variables that must stay unset', () => {
		expect(Object.keys(NOT_FORWARDED).filter((name) => name in environment)).toEqual([]);
	});

	it("defaults each forwarded setting to the MTA's own default", () => {
		const defaults = mtaCodeDefaults(SOURCES);
		const drifted: string[] = [];
		for (const [name, value] of Object.entries(environment)) {
			const expected = defaults.get(name);
			const interpolation = typeof value === 'string' ? DEFAULTED.exec(value) : null;
			if (expected === undefined || !interpolation) continue;
			if ((interpolation[1] ?? '') !== expected) {
				drifted.push(`${name}: compose ${JSON.stringify(value)}, MTA default ${expected}`);
			}
		}
		expect(drifted).toEqual([]);
	});
});

describe('.env.selfhost.example', () => {
	it('documents every MTA setting the root compose file takes from .env', () => {
		const documented = readFileSync(join(REPOSITORY_ROOT, '.env.selfhost.example'), 'utf8');
		const undocumented = Object.entries(mtaEnvironment('docker-compose.yml'))
			.filter(([name, value]) => READS.has(name) && String(value).startsWith(`\${${name}`))
			.map(([name]) => name)
			.filter((name) => !new RegExp(`^(?:# ?)?${name}=`, 'm').test(documented));
		expect(undocumented).toEqual([]);
	});
});
