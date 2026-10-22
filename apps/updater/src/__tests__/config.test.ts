import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockerHost, inheritedChildEnv, readBuildInfo } from '../config.js';

/**
 * config.ts is the updater's one reader of the environment. The build facts and
 * the Docker endpoint are read per call, as the handlers did before, so a
 * value changed after load is what `/health` and the self-update report.
 */

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedEnv = process.env;
	process.env = { PATH: '/usr/bin' };
});

afterEach(() => {
	process.env = savedEnv;
});

describe('readBuildInfo', () => {
	it('falls back when the build variables are unset or empty', () => {
		expect(readBuildInfo()).toEqual({ version: 'dev', gitSha: 'unknown', buildDate: 'unknown' });
		process.env['OWLAT_VERSION'] = '';
		expect(readBuildInfo().version).toBe('dev');
	});

	it('reports the values the container was created with', () => {
		process.env['OWLAT_VERSION'] = '0.6.16';
		process.env['OWLAT_GIT_SHA'] = 'abc1234';
		process.env['OWLAT_BUILD_DATE'] = '2026-10-01T00:00:00Z';
		expect(readBuildInfo()).toEqual({
			version: '0.6.16',
			gitSha: 'abc1234',
			buildDate: '2026-10-01T00:00:00Z',
		});
	});
});

describe('dockerHost', () => {
	it('is unset unless DOCKER_HOST is', () => {
		expect(dockerHost()).toBeUndefined();
		process.env['DOCKER_HOST'] = 'tcp://docker-socket-proxy:2375';
		expect(dockerHost()).toBe('tcp://docker-socket-proxy:2375');
	});
});

describe('inheritedChildEnv', () => {
	it('is a copy, so stripping a variable for a child leaves the updater its own', () => {
		process.env['OWLAT_VERSION'] = '0.6.16';
		const env = inheritedChildEnv();
		expect(env).toEqual({ PATH: '/usr/bin', OWLAT_VERSION: '0.6.16' });
		delete env['OWLAT_VERSION'];
		expect(process.env['OWLAT_VERSION']).toBe('0.6.16');
	});
});
