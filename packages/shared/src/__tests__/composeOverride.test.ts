import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
	mergeComposeProfiles,
	parseComposeProfileList,
	parseComposeProfilesFromEnv,
	renderComposeOverrideYaml,
} from '../composeOverride';
import { FEATURE_FLAGS, getActiveProfiles, getFlagOwnedProfiles } from '../featureFlags';

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

describe('mergeComposeProfiles — the flags own only half the line', () => {
	// `tls` activates the Caddy edge; `dashboard` the Convex dashboard. Both are
	// written by the installer and no flag state can re-derive either, so a
	// writer that treats the derived set as the whole COMPOSE_PROFILES line
	// deletes them — and the `docker compose up -d --remove-orphans` that
	// follows an apply then removes the containers behind them.
	it('keeps install-owned profiles the flag registry cannot derive', () => {
		expect(mergeComposeProfiles(['tls', 'dashboard', 'mta'], ['clamav'])).toEqual([
			'clamav',
			'dashboard',
			'tls',
		]);
	});

	it('still drops a flag-owned profile the flags no longer want', () => {
		expect(mergeComposeProfiles(['mta', 'personal-mail'], ['mta'])).toEqual(['mta']);
	});

	it('never resurrects a name the writer could not have emitted', () => {
		expect(mergeComposeProfiles(['UPPER', 'a b', 'tls'], [])).toEqual(['tls']);
	});

	it('is idempotent — merging its own output changes nothing', () => {
		const once = mergeComposeProfiles(['tls', 'personal-mail'], ['clamav', 'mta']);
		expect(mergeComposeProfiles(once, ['clamav', 'mta'])).toEqual(once);
	});

	// The guarantee that makes the split safe: every profile a flag state can
	// produce is one the merge is allowed to take away.
	it('covers everything getActiveProfiles can emit', () => {
		const owned = getFlagOwnedProfiles();
		const everythingOn = Object.fromEntries(Object.keys(FEATURE_FLAGS).map((key) => [key, true]));
		for (const profile of getActiveProfiles(everythingOn, { deliveryProvider: 'mta' })) {
			expect(owned.has(profile)).toBe(true);
		}
	});
});

describe('parseComposeProfileList — the same read, without the .env around it', () => {
	it('agrees with the .env reader', () => {
		expect(parseComposeProfileList('"mta, clamav ,mta"')).toEqual(
			parseComposeProfilesFromEnv('COMPOSE_PROFILES="mta, clamav ,mta"')
		);
		expect(parseComposeProfileList('')).toEqual([]);
	});
});
