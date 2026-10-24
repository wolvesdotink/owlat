/**
 * The runs themselves: each launches an AppImage from its own writable copy,
 * with a fresh profile, and judges the result with verdicts.ts.
 */

import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildUpdateEndpoint } from '@owlat/desktop/src/updater';
import type { Fixtures } from './build';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import { fixtureManifest, releaseAssetPath } from './release';
import { runApp } from './supervise';
import {
	livenessProblems,
	noUpdateProblems,
	rejectedProblems,
	smokeProblems,
	updatedProblems,
} from './verdicts';
import { startWebServer } from './webServer';

/** A fixture scenario that has not finished by now has hung. */
const SCENARIO_DEADLINE_MS = 180_000;
const WEB_READY_MS = 60_000;
/** Host variables a launch keeps: the display, the session bus and the locale. */
const PASSED_THROUGH = [
	'PATH',
	'DISPLAY',
	'XAUTHORITY',
	'DBUS_SESSION_BUS_ADDRESS',
	'XDG_RUNTIME_DIR',
	'LANG',
	'LC_ALL',
];

export interface Outcome {
	readonly name: string;
	readonly problems: readonly string[];
}

interface Install {
	readonly appImage: string;
	readonly env: NodeJS.ProcessEnv;
}

/**
 * A writable copy of the AppImage (the updater replaces it in place) and an
 * environment whose home, XDG and temp directories all live in `dir`. TMPDIR
 * sits next to the copy on purpose: the updater moves the old AppImage into a
 * temp directory with a rename, which only works on the same filesystem.
 */
function install(dir: string, appImage: string, extra: NodeJS.ProcessEnv): Install {
	rmSync(dir, { recursive: true, force: true });
	const home = join(dir, 'home');
	for (const sub of [
		'bin',
		'tmp',
		'home/.config',
		'home/.local/share',
		'home/.cache',
		'home/.local/state',
	]) {
		mkdirSync(join(dir, sub), { recursive: true });
	}
	const copy = join(dir, 'bin', basename(appImage));
	cpSync(appImage, copy);
	chmodSync(copy, 0o755);
	const env: NodeJS.ProcessEnv = {};
	for (const key of PASSED_THROUGH) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	return {
		appImage: copy,
		env: {
			...env,
			HOME: home,
			XDG_CONFIG_HOME: join(home, '.config'),
			XDG_DATA_HOME: join(home, '.local/share'),
			XDG_CACHE_HOME: join(home, '.cache'),
			XDG_STATE_HOME: join(home, '.local/state'),
			TMPDIR: join(dir, 'tmp'),
			// No FUSE needed (CI runners and containers often lack it); the
			// runtime still sets APPIMAGE, which the updater installs over.
			APPIMAGE_EXTRACT_AND_RUN: '1',
			// No accessibility bus under xvfb; without this GTK warns on every launch.
			NO_AT_BRIDGE: '1',
			...extra,
		},
	};
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Fixture build N, fresh profile: boots, mounts the welcome page, exits. */
export async function smoke(fixtures: Fixtures, runDir: string): Promise<Outcome> {
	const target = install(join(runDir, 'smoke'), fixtures.appImages[fixtures.from]!, {
		OWLAT_E2E_REPORT: '1',
	});
	const result = await runApp({
		command: target.appImage,
		args: [],
		env: target.env,
		deadlineMs: SCENARIO_DEADLINE_MS,
	});
	return { name: 'launch smoke', problems: smokeProblems(result, fixtures.from) };
}

/** Any AppImage, release builds included: still running at the deadline. */
export async function liveness(
	appImage: string,
	runDir: string,
	aliveMs: number
): Promise<Outcome> {
	const target = install(join(runDir, 'liveness'), appImage, {});
	const result = await runApp({
		command: target.appImage,
		args: [],
		env: target.env,
		deadlineMs: aliveMs,
	});
	return { name: `liveness (${basename(appImage)})`, problems: livenessProblems(result) };
}

interface UpdateCase {
	readonly name: string;
	/** What the fixture upstream offers, given N+1's bytes and both signatures. */
	readonly offer: 'release' | 'nothing' | 'tampered-bytes' | 'foreign-signature';
}

const UPDATE_CASES: readonly UpdateCase[] = [
	{ name: 'update N to N+1', offer: 'release' },
	{ name: 'no update (204)', offer: 'nothing' },
	{ name: 'tampered bundle', offer: 'tampered-bytes' },
	{ name: 'signature of another bundle', offer: 'foreign-signature' },
];

function offer(
	server: FixtureServer,
	fixtures: Fixtures,
	kind: UpdateCase['offer']
): { readonly assetPath: string } {
	const { from, to } = fixtures;
	const toImage = fixtures.appImages[to]!;
	const assetPath = releaseAssetPath(fixtures.repoPath, to, basename(toImage));
	const signature = (version: string) =>
		readFileSync(`${fixtures.appImages[version]!}.sig`, 'utf8').trim();
	const bytes = new Uint8Array(readFileSync(toImage));
	if (kind === 'tampered-bytes') bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
	server.setAsset(assetPath, bytes);
	server.setManifest(
		kind === 'nothing'
			? null
			: {
					version: to,
					text: fixtureManifest({
						version: to,
						url: `${server.origin}${assetPath}`,
						// A genuine signature by the same key, over N's bytes.
						signature: signature(kind === 'foreign-signature' ? from : to),
					}),
				}
	);
	return { assetPath };
}

async function updateCase(
	fixtures: Fixtures,
	runDir: string,
	server: FixtureServer,
	endpoint: string,
	testCase: UpdateCase
): Promise<Outcome> {
	const { from, to } = fixtures;
	const firstQuery = server.queries.length;
	const firstDownload = server.downloads.length;
	const { assetPath } = offer(server, fixtures, testCase.offer);
	const slug = testCase.offer;
	const target = install(join(runDir, `update-${slug}`), fixtures.appImages[from]!, {
		OWLAT_E2E_REPORT: '1',
		OWLAT_E2E_UPDATE_ENDPOINT: endpoint,
	});
	const result = await runApp({
		command: target.appImage,
		args: [],
		env: target.env,
		deadlineMs: SCENARIO_DEADLINE_MS,
	});

	const updated = testCase.offer === 'release';
	const problems = updated
		? updatedProblems(result, from, to)
		: testCase.offer === 'nothing'
			? noUpdateProblems(result, from)
			: rejectedProblems(result, from);

	const installed = sha256(target.appImage);
	const expected = sha256(fixtures.appImages[updated ? to : from]!);
	if (installed !== expected) {
		problems.push(`the installed AppImage is not ${updated ? to : from} any more`);
	}
	// The route was asked by each running version, with tauri's own target and
	// arch, and the bundle was fetched only when one was on offer.
	const queried = server.queries
		.slice(firstQuery)
		.map((q) => `${q.target}/${q.arch}/${q.currentVersion}`);
	const expectedQueries = updated
		? [`linux/x86_64/${from}`, `linux/x86_64/${to}`]
		: [`linux/x86_64/${from}`];
	if (queried.join(' ') !== expectedQueries.join(' ')) {
		problems.push(
			`the update route was queried as [${queried.join(', ')}], expected [${expectedQueries.join(', ')}]`
		);
	}
	const downloaded = server.downloads.slice(firstDownload);
	const expectedDownloads = testCase.offer === 'nothing' ? [] : [assetPath];
	if (downloaded.join(' ') !== expectedDownloads.join(' ')) {
		problems.push(
			`downloads were [${downloaded.join(', ')}], expected [${expectedDownloads.join(', ')}]`
		);
	}
	return { name: testCase.name, problems };
}

/** Every update case against the built web server's update route. */
export async function updates(fixtures: Fixtures, runDir: string): Promise<Outcome[]> {
	const server = await startFixtureServer();
	const web = await startWebServer({
		outputDir: fixtures.webServer,
		convexUrl: server.origin,
		readyWithinMs: WEB_READY_MS,
	}).catch(async (error: unknown) => {
		await server.close();
		throw error;
	});
	// The endpoint the web client hands the updater for a connected workspace.
	const endpoint = buildUpdateEndpoint(web.origin);
	try {
		const outcomes: Outcome[] = [];
		for (const testCase of UPDATE_CASES) {
			console.info(`\n== ${testCase.name}`);
			outcomes.push(await updateCase(fixtures, runDir, server, endpoint, testCase));
		}
		return outcomes;
	} finally {
		await web.stop();
		await server.close();
	}
}
