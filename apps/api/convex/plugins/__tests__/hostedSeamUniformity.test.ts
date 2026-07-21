import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every hosted contribution seam runs the SAME authorization sequence.
 *
 * Five seams used to re-implement it: parse the plugin id, look the kind up in
 * its catalog, compare ownership, freeze an actor scope, resolve the singleton
 * organization, call `authorizeSystemBundledPlugin`, and audit a denial as
 * `access_denied`. Six copies of a security-critical sequence means adding a
 * check to the shared helper silently fixes one of them, and the wire contracts
 * had already drifted — three seams took `success: boolean` where five took an
 * `outcome` union.
 *
 * This suite is the forcing function: a seam that does not delegate to
 * `hostedContributionAuthorization` fails here, and so does one that reintroduces
 * the boolean outcome. It reads the sources rather than the behaviour on purpose
 * — the property being protected is "there is exactly one implementation",
 * which no amount of per-seam behavioural testing can establish.
 */
const seamsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHARED_MODULE = 'hostedContributionAuthorization';

function seamFiles(): readonly string[] {
	return readdirSync(seamsDirectory)
		.filter((name) => name.endsWith('Authorization.ts') && !name.startsWith(SHARED_MODULE))
		.sort();
}

function read(name: string): string {
	return readFileSync(join(seamsDirectory, name), 'utf8');
}

describe('hosted contribution authorization seams', () => {
	const seams = seamFiles();

	it('finds every seam module', () => {
		// A guard against the glob silently matching nothing after a rename.
		expect(seams.length).toBeGreaterThanOrEqual(8);
		expect(seams).toContain('sendTransportAuthorization.ts');
		expect(seams).toContain('agentStepAuthorization.ts');
	});

	it.each(seamFiles())('%s delegates to the one shared implementation', (name) => {
		const source = read(name);
		expect(source, `${name} must build on ${SHARED_MODULE}`).toContain(
			`from './${SHARED_MODULE}'`
		);
		expect(source).toContain('HostedContributionAuthorizationSpec');
		expect(source).toMatch(/authorizeHostedContribution\(/);
	});

	it.each(seamFiles())('%s does not re-implement the sequence', (name) => {
		const source = read(name);
		// The building blocks the shared helper owns. A seam reaching for them
		// directly is a second copy of the authorization path.
		for (const forbidden of [
			'authorizeSystemBundledPlugin',
			'recordHostedPluginAudit',
			'SYSTEM_PLUGIN_ACTOR_ID',
			'getSingletonOrganizationId',
			"reasonCode: 'access_denied'",
		]) {
			expect(source.includes(forbidden), `${name} re-implements ${forbidden}`).toBe(false);
		}
	});

	it.each(seamFiles())('%s records outcomes on the one wire contract', (name) => {
		const source = read(name);
		if (!source.includes('recordOutcome')) return;
		expect(source, `${name} still takes a boolean outcome`).not.toContain('success: v.boolean()');
		expect(source).toContain("outcome: v.union(v.literal('completed'), v.literal('failed'))");
	});
});
