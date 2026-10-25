/**
 * scripts/e2e-update-flow-dind.sh starts a Docker daemon of its own on a host
 * that other runs, or a daemon kept with KEEP=1, may share. Whatever happens
 * while it starts, its cleanup may remove only what this run created. These
 * cases run the REAL script against a stand-in `docker` on PATH that keeps its
 * containers and volumes as files, with another run's daemon already there,
 * and check what is left afterwards. No real Docker command runs.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../e2e-update-flow-dind.sh', import.meta.url));
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A stand-in for the docker CLI. A container is `$STATE/containers/<name>`
 * holding `<id> <owner token>`, a volume is `$STATE/volumes/<name>` holding its
 * owner token. Every call goes to $STATE/calls. MOCK_* pick the failure:
 *   MOCK_EXISTS=1          every container and volume name is taken
 *   MOCK_VOLUME=reused     `volume create` hands back an existing volume
 *   MOCK_RUN=conflict      `run` fails before creating anything (name taken)
 *   MOCK_RUN=start-fails   `run` creates the container, then fails
 *   MOCK_DAEMON=down       the daemon inside never answers
 */
const DOCKER = `#!/usr/bin/env bash
set -u
echo "$*" >>"$STATE/calls"
token_of() { local v="$1"; echo "\${v#*owlat.update-flow.owner=}"; }
case "$1 \${2:-}" in
"container inspect")
	[[ "\${MOCK_EXISTS:-}" == 1 || -f "$STATE/containers/$3" ]] ;;
"volume inspect")
	name="\${!#}"
	[[ "\${MOCK_EXISTS:-}" == 1 && "$3" != --format ]] && exit 0
	[[ -f "$STATE/volumes/$name" ]] || exit 1
	[[ "$3" == --format ]] && cat "$STATE/volumes/$name"
	exit 0 ;;
"volume create")
	name="\${!#}"
	if [[ "\${MOCK_VOLUME:-}" == reused ]]; then
		echo other-run >"$STATE/volumes/$name"
	elif [[ ! -f "$STATE/volumes/$name" ]]; then
		token_of "$4" >"$STATE/volumes/$name"
	fi
	echo "$name" ;;
"volume ls")
	want="$(token_of "\${!#}")"
	for f in "$STATE"/volumes/*; do
		[[ -f "$f" && "$(cat "$f")" == "$want" ]] && basename "$f"
	done
	exit 0 ;;
"volume rm")
	shift 2
	for name in "$@"; do rm -f "$STATE/volumes/$name"; done ;;
"ps -aq")
	want="$(token_of "\${!#}")"
	for f in "$STATE"/containers/*; do
		[[ -f "$f" ]] || continue
		read -r id owner <"$f"
		[[ "$owner" == "$want" ]] && echo "$id"
	done
	exit 0 ;;
"rm -f")
	shift 3
	for id in "$@"; do
		for f in "$STATE"/containers/*; do
			[[ -f "$f" ]] || continue
			read -r cid _ <"$f"
			[[ "$cid" == "$id" ]] && rm -f "$f"
		done
	done ;;
run*)
	if [[ "\${MOCK_RUN:-}" == conflict ]]; then
		echo 'Conflict. The container name is already in use' >&2
		exit 125
	fi
	shift
	name='' owner=''
	while (($#)); do
		case "$1" in
		--name) name="$2"; shift 2 ;;
		--label) owner="$(token_of "$2")"; shift 2 ;;
		*) shift ;;
		esac
	done
	echo "cid-$name $owner" >"$STATE/containers/$name"
	if [[ "\${MOCK_RUN:-}" == start-fails ]]; then
		echo 'failed to start' >&2
		exit 125
	fi
	echo "cid-$name" ;;
exec*)
	[[ "\${MOCK_DAEMON:-}" == down ]] && exit 1
	exit 0 ;;
inspect*)
	[[ "\${MOCK_DAEMON:-}" == down ]] && echo false || echo true ;;
logs*) exit 0 ;;
*)
	echo "unexpected docker $*" >&2
	exit 99 ;;
esac
`;

const OTHER_CONTAINER = 'owlat-update-flow-success';
const OTHER_VOLUME = `${OTHER_CONTAINER}-docker`;

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'owlat-update-flow-dind-'));
	roots.push(root);
	const bin = join(root, 'bin');
	const state = join(root, 'state');
	await mkdir(bin);
	await mkdir(join(state, 'containers'), { recursive: true });
	await mkdir(join(state, 'volumes'));
	await writeFile(join(state, 'calls'), '');
	await writeFile(join(bin, 'docker'), DOCKER);
	await chmod(join(bin, 'docker'), 0o755);
	// Another run's daemon, under the very prefix this run uses.
	await writeFile(join(state, 'containers', OTHER_CONTAINER), 'other-id other-run\n');
	await writeFile(join(state, 'volumes', OTHER_VOLUME), 'other-run\n');
	return { root, bin, state };
}

async function run(env: Record<string, string> = {}) {
	const { root, bin, state } = await setup();
	const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
		execFile(
			'bash',
			[SCRIPT, '1.2.0', '1.3.0'],
			{
				cwd: root,
				env: {
					...process.env,
					PATH: `${bin}:${process.env['PATH']}`,
					STATE: state,
					DIND_NAME: OTHER_CONTAINER,
					...env,
				},
			},
			(error, _stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
				resolve({ code, stderr });
			}
		);
	});
	const calls = (await readFile(join(state, 'calls'), 'utf8')).split('\n').filter(Boolean);
	const containers = (await readdir(join(state, 'containers'))).sort();
	const volumes = (await readdir(join(state, 'volumes'))).sort();
	return { ...result, calls, containers, volumes };
}

/** No removal ever names the other run's container or volume. */
function expectOtherRunUntouched(r: Awaited<ReturnType<typeof run>>) {
	expect(r.containers).toContain(OTHER_CONTAINER);
	expect(r.volumes).toContain(OTHER_VOLUME);
	for (const call of r.calls.filter((c) => /^(rm|volume rm)\b/.test(c))) {
		expect(call).not.toMatch(/\bother-id\b/);
		expect(call.split(' ')).not.toContain(OTHER_CONTAINER);
		expect(call.split(' ')).not.toContain(OTHER_VOLUME);
	}
}

describe('e2e-update-flow-dind.sh cleanup', () => {
	it('rejects an invalid TEMPLATE_DIR before calling docker at all', async () => {
		const r = await run({ TEMPLATE_DIR: '/nonexistent/update-target' });
		expect(r.code).toBe(2);
		expect(r.stderr).toContain('is not a directory');
		expect(r.calls).toEqual([]);
		expectOtherRunUntouched(r);
	});

	it('rejects a DIND_NAME that is not a plain name before calling docker', async () => {
		const r = await run({ DIND_NAME: '../host' });
		expect(r.code).toBe(2);
		expect(r.calls).toEqual([]);
	});

	it('refuses a name that is already taken and removes nothing', async () => {
		const r = await run({ MOCK_EXISTS: '1' });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('already exists');
		expect(r.calls.some((c) => /^(run|volume create|rm|volume rm)\b/.test(c))).toBe(false);
		expectOtherRunUntouched(r);
	});

	it('refuses a volume another run created under the same name and leaves it', async () => {
		const r = await run({ MOCK_VOLUME: 'reused' });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('created by another run');
		expect(r.calls.some((c) => /^(run|rm|volume rm)\b/.test(c))).toBe(false);
		// The reused volume stays: it is not this run's to remove.
		expect(r.volumes).toHaveLength(2);
		expectOtherRunUntouched(r);
	});

	it('removes only its own volume when the container name is taken', async () => {
		const r = await run({ MOCK_RUN: 'conflict' });
		expect(r.code).toBe(125);
		expect(r.calls.some((c) => c.startsWith('rm '))).toBe(false);
		expect(r.containers).toEqual([OTHER_CONTAINER]);
		expect(r.volumes).toEqual([OTHER_VOLUME]);
		expectOtherRunUntouched(r);
	});

	it('removes its own container and volume when the container fails to start', async () => {
		const r = await run({ MOCK_RUN: 'start-fails' });
		expect(r.code).toBe(125);
		expect(r.containers).toEqual([OTHER_CONTAINER]);
		expect(r.volumes).toEqual([OTHER_VOLUME]);
		expectOtherRunUntouched(r);
	});

	it('removes its own daemon when it never comes up', async () => {
		const r = await run({ MOCK_DAEMON: 'down' });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('never came up');
		expect(r.containers).toEqual([OTHER_CONTAINER]);
		expect(r.volumes).toEqual([OTHER_VOLUME]);
		expectOtherRunUntouched(r);
	});

	it('runs the harness in the container it created, then removes only that', async () => {
		const r = await run();
		expect(r.code).toBe(0);
		const created = r.calls.find((c) => c.startsWith('run '))!;
		const name = /--name (\S+)/.exec(created)![1]!;
		expect(name).toMatch(new RegExp(`^${OTHER_CONTAINER}-[0-9a-f]{12}$`));
		expect(r.calls).toContainEqual(
			expect.stringMatching(
				new RegExp(
					`^exec .* cid-${name} bash /src/scripts/e2e-update-flow\\.sh 1\\.2\\.0 1\\.3\\.0$`
				)
			)
		);
		expect(r.calls).toContain(`rm -f -v cid-${name}`);
		expect(r.calls).toContain(`volume rm ${name}-docker`);
		expect(r.containers).toEqual([OTHER_CONTAINER]);
		expect(r.volumes).toEqual([OTHER_VOLUME]);
		expectOtherRunUntouched(r);
	});

	it('leaves its own daemon running under KEEP=1', async () => {
		const r = await run({ KEEP: '1' });
		expect(r.code).toBe(0);
		expect(r.calls.some((c) => /^(rm|volume rm)\b/.test(c))).toBe(false);
		expect(r.containers).toHaveLength(2);
		expect(r.volumes).toHaveLength(2);
	});
});
