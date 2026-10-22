/**
 * `bun run dev:stack` port and identity resolution
 * (scripts/dev-stack/config.ts) and the env-file helpers it writes with
 * (scripts/dev-stack/envFile.ts).
 */

import { describe, expect, it } from 'vitest';
import {
	BASE_PORTS,
	DevStackConfigError,
	MAX_EXPLICIT_OFFSET,
	OFFSET_MIN,
	OFFSET_SLOTS,
	OFFSET_STRIDE,
	composeProjectName,
	deploymentUrlEnv,
	portsFor,
	resolveDevStackConfig,
	resolvePortOffset,
	webEnv,
} from '../dev-stack/config';
import { parseAdminKey, parseEnv, upsertEnv } from '../dev-stack/envFile';

const linked = (root: string, explicit?: string) => ({ root, linkedWorktree: true, explicit });

describe('resolvePortOffset', () => {
	it('keeps the canonical ports in the main checkout', () => {
		const resolved = resolvePortOffset({
			root: '/src/owlat',
			linkedWorktree: false,
			explicit: undefined,
		});
		expect(resolved.offset).toBe(0);
		expect(portsFor(resolved.offset)).toEqual(BASE_PORTS);
	});

	it('derives a stable offset from the worktree path', () => {
		const a = resolvePortOffset(linked('/work/owlat-a'));
		expect(resolvePortOffset(linked('/work/owlat-a'))).toEqual(a);
		expect(a.offset).toBeGreaterThanOrEqual(OFFSET_MIN);
		expect((a.offset - OFFSET_MIN) % OFFSET_STRIDE).toBe(0);
		expect(a.source).toMatch(/hash of the worktree path/);
	});

	it('spreads different worktrees over different offsets', () => {
		const offsets = new Set(
			Array.from({ length: 20 }, (_, i) => resolvePortOffset(linked(`/work/wt-${i}`)).offset)
		);
		expect(offsets.size).toBeGreaterThan(15);
	});

	it('keeps every hashed port below the ephemeral range', () => {
		const highest = OFFSET_MIN + OFFSET_STRIDE * (OFFSET_SLOTS - 1);
		for (const port of Object.values(portsFor(highest))) expect(port).toBeLessThan(32_768);
	});

	it('honours an explicit OWLAT_PORT_OFFSET, including 0 in a worktree', () => {
		expect(resolvePortOffset(linked('/work/x', '0'))).toEqual({
			offset: 0,
			source: 'OWLAT_PORT_OFFSET=0',
		});
		expect(resolvePortOffset(linked('/work/x', ' 42 ')).offset).toBe(42);
		expect(resolvePortOffset(linked('/work/x', '')).source).toMatch(/hash/);
	});

	it.each(['-1', '1.5', 'abc', '10e3', String(MAX_EXPLICIT_OFFSET + 1)])(
		'rejects OWLAT_PORT_OFFSET=%s',
		(value) => {
			expect(() => resolvePortOffset(linked('/work/x', value))).toThrow(DevStackConfigError);
		}
	);

	it('accepts the largest offset that keeps every port valid', () => {
		const ports = portsFor(
			resolvePortOffset(linked('/work/x', String(MAX_EXPLICIT_OFFSET))).offset
		);
		expect(Math.max(...Object.values(ports))).toBe(65_535);
	});
});

describe('cross-service collisions between worktrees', () => {
	it('the stride divides no difference between two base ports', () => {
		const bases = Object.values(BASE_PORTS);
		for (const a of bases) {
			for (const b of bases) {
				if (a !== b) expect(Math.abs(a - b) % OFFSET_STRIDE).not.toBe(0);
			}
		}
	});

	it('two different slots never share a port, whatever the service', () => {
		const portsOfSlot = (slot: number) =>
			Object.values(portsFor(OFFSET_MIN + OFFSET_STRIDE * slot));
		for (let a = 0; a < 40; a += 1) {
			const taken = new Set(portsOfSlot(a));
			for (let b = a + 1; b < 40; b += 1) {
				for (const port of portsOfSlot(b)) expect(taken.has(port)).toBe(false);
			}
		}
	});

	it('one checkout never binds two services to the same port', () => {
		const ports = Object.values(portsFor(resolvePortOffset(linked('/work/y')).offset));
		expect(new Set(ports).size).toBe(ports.length);
	});
});

describe('resolveDevStackConfig', () => {
	const config = resolveDevStackConfig(linked('/work/owlat-feature', '100'));

	it('derives every URL from the same ports', () => {
		expect(config.ports.web).toBe(3100);
		expect(config.urls).toEqual({
			web: 'http://localhost:3100',
			convex: 'http://127.0.0.1:3310',
			convexSite: 'http://127.0.0.1:3311',
		});
	});

	it('points the web app, SITE_URL and the allowed origins at one origin', () => {
		const web = webEnv(config);
		expect(web['PORT']).toBe('3100');
		expect(web['NUXT_PORT']).toBe('3100');
		expect(web['NUXT_PUBLIC_SITE_URL']).toBe(config.urls.web);
		expect(web['NUXT_PUBLIC_CONVEX_URL']).toBe(config.urls.convex);
		expect(web['NUXT_PUBLIC_CONVEX_SITE_URL']).toBe(config.urls.convexSite);
		expect(deploymentUrlEnv(config)).toEqual({
			SITE_URL: config.urls.web,
			ALLOWED_ORIGINS: config.urls.web,
		});
	});
});

describe('composeProjectName', () => {
	it('is a valid Compose name, stable per path and distinct per path', () => {
		const name = composeProjectName('/work/T3 Worktrees/Owlat_Feature.X');
		expect(name).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
		expect(name).toMatch(/^owlat-dev-owlat-feature-x-[0-9a-f]{8}$/);
		expect(composeProjectName('/work/T3 Worktrees/Owlat_Feature.X')).toBe(name);
		expect(composeProjectName('/other/Owlat_Feature.X')).not.toBe(name);
	});

	it('copes with a basename that has no usable characters', () => {
		expect(composeProjectName('/work/___')).toMatch(/^owlat-dev-[0-9a-f]{8}$/);
	});
});

describe('env files', () => {
	it('sets keys in place and appends missing ones, keeping everything else', () => {
		const before = '# comment\nCONVEX_URL=http://x\n\nKEEP=1\n';
		const after = upsertEnv(before, { CONVEX_URL: 'http://y', NEW_KEY: 'v' });
		expect(after).toBe('# comment\nCONVEX_URL=http://y\n\nKEEP=1\nNEW_KEY=v\n');
		expect(upsertEnv(after, { CONVEX_URL: 'http://y', NEW_KEY: 'v' })).toBe(after);
		expect(upsertEnv('', { A: '1' })).toBe('A=1\n');
	});

	it('refuses values that would need quoting', () => {
		expect(() => upsertEnv('', { A: 'two words' })).toThrow(/quoting/);
	});

	it('parses quoted and exported values', () => {
		expect(parseEnv('export A="x y"\nB=\'z\'\n# C=1\nD = 4 ')).toEqual({
			A: 'x y',
			B: 'z',
			D: '4',
		});
	});

	it('reads the admin key from generate_admin_key.sh output', () => {
		const key = `convex-self-hosted|${'ab'.repeat(40)}`;
		expect(parseAdminKey(`Admin key:\n${key}\n`)).toBe(key);
		expect(parseAdminKey('no key here')).toBeNull();
	});
});
