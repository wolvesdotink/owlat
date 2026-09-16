import { describe, it, expect } from 'vitest';
import {
	evaluateContainerStates,
	evaluateVersionDrift,
	hasVersionDrift,
	isOwlatOwnedImage,
	parseComposePs,
	splitImageRef,
	type ComposeService,
} from '../containerHealth';

function service(overrides: Partial<ComposeService> = {}): ComposeService {
	return {
		service: 'web',
		state: 'running',
		status: 'Up 2 hours',
		image: 'ghcr.io/wolvesdotink/web:0.4.13',
		imageTag: '0.4.13',
		health: 'healthy',
		...overrides,
	};
}

describe('splitImageRef', () => {
	it('splits a normal tagged reference', () => {
		expect(splitImageRef('ghcr.io/wolvesdotink/web:0.4.13')).toEqual({
			repository: 'ghcr.io/wolvesdotink/web',
			tag: '0.4.13',
		});
	});

	it('does NOT mistake a registry port for a tag', () => {
		// `split(':').pop()` would answer "5000/owlat/web" here.
		expect(splitImageRef('registry.example.com:5000/owlat/web')).toEqual({
			repository: 'registry.example.com:5000/owlat/web',
			tag: '',
		});
		expect(splitImageRef('registry.example.com:5000/owlat/web:0.4.13')).toEqual({
			repository: 'registry.example.com:5000/owlat/web',
			tag: '0.4.13',
		});
	});

	it('reports no tag for a digest pin', () => {
		expect(splitImageRef('ghcr.io/wolvesdotink/web@sha256:abc123')).toEqual({
			repository: 'ghcr.io/wolvesdotink/web',
			tag: '',
		});
	});
});

describe('isOwlatOwnedImage', () => {
	it('claims published and locally-built Owlat images', () => {
		expect(isOwlatOwnedImage('ghcr.io/wolvesdotink/web:0.4.13')).toBe(true);
		expect(isOwlatOwnedImage('ghcr.io/wolvesdotink/imap:0.4.12')).toBe(true);
		expect(isOwlatOwnedImage('owlat-code-worker:0.4.13')).toBe(true);
		expect(isOwlatOwnedImage('owlat-convex-fn-proxy:dev')).toBe(true);
	});

	it('does NOT claim third-party images pinned to their own versions', () => {
		// These would otherwise all report as "drifted" on every install.
		for (const image of [
			'redis:7.4-alpine',
			'caddy:2.8-alpine',
			'alpine:3.20',
			'ollama/ollama:latest',
			'tecnativa/docker-socket-proxy:0.3',
			'ghcr.io/get-convex/convex-backend:latest',
		]) {
			expect(isOwlatOwnedImage(image)).toBe(false);
		}
	});
});

describe('parseComposePs', () => {
	const ndjson = [
		'{"Service":"web","State":"running","Status":"Up 2 hours","Image":"ghcr.io/wolvesdotink/web:0.4.12","Health":"healthy"}',
		'{"Service":"imap","State":"restarting","Status":"Restarting (1) 5 seconds ago","Image":"ghcr.io/wolvesdotink/imap:0.4.12","Health":""}',
	].join('\n');

	it('parses NDJSON output (one object per line)', () => {
		const parsed = parseComposePs(ndjson);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({ service: 'web', state: 'running', imageTag: '0.4.12' });
		expect(parsed[1]).toMatchObject({ service: 'imap', state: 'restarting', imageTag: '0.4.12' });
	});

	it('parses the JSON-array shape other Compose versions emit', () => {
		const asArray = JSON.stringify(ndjson.split('\n').map((line) => JSON.parse(line)));
		expect(parseComposePs(asArray)).toEqual(parseComposePs(ndjson));
	});

	it('lowercases State and Health so comparisons are stable', () => {
		const parsed = parseComposePs('{"Service":"web","State":"Running","Health":"Healthy"}');
		expect(parsed[0]?.state).toBe('running');
		expect(parsed[0]?.health).toBe('healthy');
	});

	it('returns [] for empty input and skips unparseable lines rather than throwing', () => {
		expect(parseComposePs('')).toEqual([]);
		expect(parseComposePs('   \n  ')).toEqual([]);
		const mixed = `warning: something went to stdout\n${ndjson.split('\n')[1]}`;
		expect(parseComposePs(mixed)).toHaveLength(1);
	});

	it('tolerates rows with missing fields', () => {
		const parsed = parseComposePs('{"Service":"web"}');
		expect(parsed[0]).toEqual({
			service: 'web',
			state: '',
			status: '',
			image: '',
			imageTag: '',
			health: '',
		});
	});
});

describe('evaluateContainerStates', () => {
	it('summarizes a healthy fleet in ONE passing finding, not one per container', () => {
		const findings = evaluateContainerStates([
			service({ service: 'web' }),
			service({ service: 'mta' }),
			service({ service: 'imap' }),
		]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ok).toBe(true);
		expect(findings[0]?.message).toContain('3 running container(s) are healthy');
	});

	it('FAILS on a crash-looping container and surfaces its status line', () => {
		// The observed production case: imap restarting for 11+ hours, unnoticed.
		const findings = evaluateContainerStates([
			service({ service: 'web' }),
			service({
				service: 'imap',
				state: 'restarting',
				status: 'Restarting (1) 5 seconds ago',
				health: '',
			}),
		]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ok).toBe(false);
		expect(findings[0]?.message).toContain('imap');
		expect(findings[0]?.message).toContain('not running (restarting)');
		expect(findings[0]?.message).toContain('Restarting (1) 5 seconds ago');
	});

	it('FAILS a container that is running but failing its healthcheck', () => {
		const findings = evaluateContainerStates([
			service({
				service: 'mta',
				state: 'running',
				status: 'Up 3 hours (unhealthy)',
				health: 'unhealthy',
			}),
		]);
		expect(findings[0]?.ok).toBe(false);
		expect(findings[0]?.message).toContain('failing its healthcheck');
	});

	it('accepts a running container with no healthcheck configured', () => {
		const findings = evaluateContainerStates([service({ health: '' })]);
		expect(findings[0]?.ok).toBe(true);
	});

	it('treats a "starting" healthcheck as not-yet-failed', () => {
		const findings = evaluateContainerStates([service({ health: 'starting' })]);
		expect(findings[0]?.ok).toBe(true);
	});

	it('returns no findings when there is nothing to judge', () => {
		expect(evaluateContainerStates([])).toEqual([]);
	});
});

describe('evaluateVersionDrift', () => {
	it('detects the observed case: .env says 0.4.13, every container runs 0.4.12', () => {
		const services = ['web', 'mta', 'updater', 'clamav', 'imap'].map((name) =>
			service({
				service: name,
				image: `ghcr.io/wolvesdotink/${name}:0.4.12`,
				imageTag: '0.4.12',
			})
		);
		const findings = evaluateVersionDrift(services, '0.4.13');

		expect(findings.every((finding) => !finding.ok)).toBe(true);
		// One per drifted service, plus a single actionable summary.
		expect(findings).toHaveLength(6);
		expect(findings[0]?.message).toContain('runs 0.4.12 but OWLAT_VERSION is 0.4.13');
		expect(findings.at(-1)?.message).toContain('5 of 5');
		expect(findings.at(-1)?.message).toContain('docker compose up -d');
		expect(hasVersionDrift(services, '0.4.13')).toBe(true);
	});

	it('PASSES with one summary finding when every Owlat container matches', () => {
		const services = [
			service({ service: 'web', image: 'ghcr.io/wolvesdotink/web:0.4.13', imageTag: '0.4.13' }),
			service({ service: 'mta', image: 'ghcr.io/wolvesdotink/mta:0.4.13', imageTag: '0.4.13' }),
		];
		const findings = evaluateVersionDrift(services, '0.4.13');
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ok).toBe(true);
		expect(hasVersionDrift(services, '0.4.13')).toBe(false);
	});

	it('flags a PARTIAL update — the half-recreated stack', () => {
		const services = [
			service({ service: 'web', image: 'ghcr.io/wolvesdotink/web:0.4.13', imageTag: '0.4.13' }),
			service({ service: 'imap', image: 'ghcr.io/wolvesdotink/imap:0.4.12', imageTag: '0.4.12' }),
		];
		const findings = evaluateVersionDrift(services, '0.4.13');
		const failures = findings.filter((finding) => !finding.ok);
		expect(failures).toHaveLength(2);
		expect(failures[0]?.message).toContain('imap');
		expect(failures.some((finding) => finding.message.includes('web'))).toBe(false);
	});

	it('IGNORES third-party images pinned to their own versions', () => {
		const services = [
			service({ service: 'web', image: 'ghcr.io/wolvesdotink/web:0.4.13', imageTag: '0.4.13' }),
			service({ service: 'redis', image: 'redis:7.4-alpine', imageTag: '7.4-alpine' }),
			service({ service: 'caddy', image: 'caddy:2.8-alpine', imageTag: '2.8-alpine' }),
			service({
				service: 'convex',
				image: 'ghcr.io/get-convex/convex-backend:latest',
				imageTag: 'latest',
			}),
		];
		const findings = evaluateVersionDrift(services, '0.4.13');
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ok).toBe(true);
		expect(findings[0]?.message).toContain('1 Owlat container(s)');
	});

	it('compares local dev builds too (dev pin is still a pin)', () => {
		const services = [service({ image: 'owlat-code-worker:dev', imageTag: 'dev' })];
		expect(hasVersionDrift(services, 'dev')).toBe(false);
		expect(hasVersionDrift(services, '0.4.13')).toBe(true);
	});

	it('stays silent when there is no configured version to compare against', () => {
		// An absent OWLAT_VERSION is reported by the env checks; guessing here
		// would turn one failure into a cascade of misleading ones.
		expect(evaluateVersionDrift([service()], '')).toEqual([]);
		expect(hasVersionDrift([service()], '')).toBe(false);
	});

	it('stays silent when no Owlat-owned container is running', () => {
		expect(evaluateVersionDrift([service({ image: 'redis:7.4-alpine' })], '0.4.13')).toEqual([]);
	});
});
