import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseComposeProfilesFromEnv, renderComposeOverrideYaml } from '../composeOverride';
import { FEATURE_FLAGS } from '../featureFlags';

describe('shared override writer — compose-safe output', () => {
	// The updater regenerates docker-compose.override.yml from this renderer on
	// every /apply-profiles; malformed YAML here would break every subsequent
	// `docker compose` invocation on the host.
	it('renders parseable YAML that round-trips the profile list', () => {
		const yaml = renderComposeOverrideYaml(['personal-mail', 'mta']);
		const doc = parseYaml(yaml) as {
			'x-owlat-profiles': string[];
			services: Record<
				string,
				{ image: string; command: unknown; profiles: string[]; restart: unknown }
			>;
		};
		expect(doc['x-owlat-profiles']).toEqual(['mta', 'personal-mail']);
		expect(Object.keys(doc.services)).toEqual(['__mta_marker', '__personal-mail_marker']);
		for (const [name, marker] of Object.entries(doc.services)) {
			expect(marker.profiles).toEqual([name.replace(/^__/, '').replace(/_marker$/, '')]);
			// Compose requires string scalars here — a bare true/no would type-error.
			expect(marker.command).toBe('true');
			expect(marker.restart).toBe('no');
		}
	});

	it('renders an empty state as valid YAML with no services', () => {
		const doc = parseYaml(renderComposeOverrideYaml([])) as Record<string, unknown>;
		expect(doc['x-owlat-profiles']).toEqual([]);
		expect(doc['services']).toEqual({});
	});

	it('marker services use only busybox — inside the updater compose-template image allowlist', () => {
		const yaml = renderComposeOverrideYaml([
			...new Set(Object.values(FEATURE_FLAGS).flatMap((def) => [...(def.dockerProfiles ?? [])])),
		]);
		for (const line of yaml.match(/^\s*image:.*$/gm) ?? []) {
			expect(line.trim()).toBe('image: busybox:stable');
		}
	});

	it('refuses profile names that cannot be embedded verbatim', () => {
		for (const evil of ['mta\nservices:', 'a b', 'UPPER', '', '-lead', 'x:y']) {
			expect(() => renderComposeOverrideYaml([evil])).toThrow(/Unsafe compose profile name/);
		}
	});
});

describe('applied-profile reader — inverse of the COMPOSE_PROFILES writer', () => {
	// The drift probe compares this reader's output against getActiveProfiles;
	// a mismatch in normalization would report phantom drift on every reload.
	it('round-trips the line the updater writes, normalized to sorted unique names', () => {
		const written = ['personal-mail', 'mta', 'clamav'];
		const env = `# managed by owlat\nCOMPOSE_PROFILES=${written.join(',')}\nFOO=bar\n`;
		expect(parseComposeProfilesFromEnv(env)).toEqual(['clamav', 'mta', 'personal-mail']);
	});

	it('reads an empty / absent line as no active profiles', () => {
		expect(parseComposeProfilesFromEnv('COMPOSE_PROFILES=\n')).toEqual([]);
		expect(parseComposeProfilesFromEnv('FOO=bar\n')).toEqual([]);
		expect(parseComposeProfilesFromEnv('COMPOSE_PROFILES=" "\n')).toEqual([]);
	});

	it('tolerates quoting, spacing and duplicates from a hand-edited file', () => {
		expect(parseComposeProfilesFromEnv('COMPOSE_PROFILES="mta, clamav ,mta"')).toEqual([
			'clamav',
			'mta',
		]);
	});

	it('drops entries the writer could never have emitted', () => {
		expect(parseComposeProfilesFromEnv('COMPOSE_PROFILES=mta,UPPER,x:y,-lead,a b')).toEqual([
			'mta',
		]);
	});
});
