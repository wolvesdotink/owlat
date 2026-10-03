/**
 * Shared fixture for the backup/restore tests (restore*.test.ts).
 *
 * The cases run the REAL scripts/backup.sh and scripts/restore.sh against a
 * fake `docker` on PATH. The fake keeps each named volume as a plain directory
 * and runs the scripts' container commands on the host with the mount points
 * mapped to those directories, so a test can check the data a failure leaves
 * behind, not just the calls made. Failures are injected by matching the
 * fake's argv against a regex.
 *
 * `docker compose` resolves the project and the volume names the way Compose
 * does: COMPOSE_PROJECT_NAME from the environment, then from the env file
 * (`--env-file`, else `.env`), then a top-level `name:` in the compose files
 * (`-f`, else docker-compose.yml plus docker-compose.override.yml, later files
 * winning), then the directory name. A top-level volume is `<project>_<key>`
 * unless a file gives it an explicit `name:`. Every `up` and `down` records
 * the project it resolved, so a case can check which volumes the started
 * stack mounts.
 */
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export const RESTORE = fileURLToPath(new URL('../restore.sh', import.meta.url));
export const BACKUP = fileURLToPath(new URL('../backup.sh', import.meta.url));
export const PROJECT = 'owlat';

export const run = promisify(execFile);
const roots: string[] = [];

/** Register with `afterAll` in every file that builds hosts. */
export async function cleanupRoots(): Promise<void> {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/** The install's compose file: the project is `owlat` wherever it is checked out. */
const COMPOSE_FILE =
	'name: owlat\nservices: {}\nvolumes:\n  convex-data:\n  redis-data:\n  mail-certs:\n';
/** The same without a top-level name: the project comes from the directory. */
export const COMPOSE_WITHOUT_NAME = COMPOSE_FILE.replace('name: owlat\n', '');

/*
 * FAKE_DOCKER_FAIL        regex; a matching call exits 1 without doing anything
 * FAKE_DOCKER_FAIL_ONCE   set: only the first matching call fails (transient)
 * FAKE_DOCKER_FAIL_AFTER  regex; a matching call does its work, then exits 1
 *                         (a partial extraction)
 * FAKE_DOCKER_PS          what `docker ps` prints (a container still running)
 * FAKE_DOCKER_PS_FILTER   regex; `docker ps` prints FAKE_DOCKER_PS only for a
 *                         matching call (one project's containers running)
 * FAKE_DOCKER_HANG        regex; the first matching call writes "$FAKE_DOCKER_ROOT/hanging"
 *                         and then blocks (a step the operator interrupts)
 * FAKE_DOCKER_SERVICES    what `docker compose ps --services` prints
 * FAKE_COMPOSE_DISCOVERED_NAME  project name Compose resolves whenever it finds
 *                         the files itself (no -f): a resolution the restore
 *                         could not foresee
 * FAKE_COMPOSE_REQUIRES   a variable every `compose` call needs in its env file
 *                         (an archived .env from before it was required)
 * FAKE_COMPOSE_DISCOVERED_VOLUME  "<key>=<name>": the name Compose resolves for
 *                         the volume <key> whenever it finds the files itself
 *
 * A volume's labels live in "$FAKE_DOCKER_ROOT/labels/<name>". A volume
 * without that file is a Compose default-named "<project>_<key>" volume.
 *
 * Like the real Compose, which cannot interpolate the file's required
 * `${VAR:?}` secrets without them, every `compose` call fails when there is no
 * .env in the working directory and no --env-file.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
line="$*"
if [[ -n "\${FAKE_DOCKER_FAIL:-}" && "$line" =~ $FAKE_DOCKER_FAIL ]]; then
	if [[ -z "\${FAKE_DOCKER_FAIL_ONCE:-}" || ! -e "$FAKE_DOCKER_ROOT/failed-once" ]]; then
		touch "$FAKE_DOCKER_ROOT/failed-once"
		echo "fake docker: injected failure" >&2
		exit 1
	fi
fi
fail_after=0
if [[ -n "\${FAKE_DOCKER_FAIL_AFTER:-}" && "$line" =~ $FAKE_DOCKER_FAIL_AFTER ]]; then
	fail_after=1
fi
if [[ -n "\${FAKE_DOCKER_HANG:-}" && "$line" =~ $FAKE_DOCKER_HANG && ! -e "$FAKE_DOCKER_ROOT/hanging" ]]; then
	# A builtin, not touch: a SIGINT landing while a child exits counts as handled
	# by the child, and this shell would go on into the sleep instead of dying.
	: > "$FAKE_DOCKER_ROOT/hanging"
	sleep 30
fi
vols="$FAKE_DOCKER_ROOT/volumes"
case "$1" in
	compose)
		shift
		env_file=""; files=()
		while [[ "$1" == --env-file || "$1" == -f ]]; do
			if [[ "$1" == --env-file ]]; then env_file="$2"; else files+=("$2"); fi
			shift 2
		done
		[[ -z "$env_file" && -f .env ]] && env_file=.env
		if [[ -z "$env_file" ]]; then
			echo "error while interpolating services.worker.environment.REDIS_URL: required variable REDIS_PASSWORD is missing a value" >&2
			exit 1
		fi
		if [[ -n "\${FAKE_COMPOSE_REQUIRES:-}" ]] && ! grep -q "^$FAKE_COMPOSE_REQUIRES=" "$env_file"; then
			echo "error while interpolating services.worker.environment: required variable $FAKE_COMPOSE_REQUIRES is missing a value" >&2
			exit 1
		fi
		if [[ "$1" != config && "$1" != up && "$1" != down ]]; then
			# ps, stop, start (backup.sh pausing convex and redis): only ps answers.
			[[ "$1" == ps && -n "\${FAKE_DOCKER_SERVICES:-}" ]] && printf '%s\\n' $FAKE_DOCKER_SERVICES
			exit 0
		fi
		discovered=0
		if [[ \${#files[@]} -eq 0 ]]; then
			discovered=1
			files=(docker-compose.yml)
			[[ -f docker-compose.override.yml ]] && files+=(docker-compose.override.yml)
		fi
		project="\${COMPOSE_PROJECT_NAME:-}"
		[[ -n "$project" ]] || project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$env_file" | tail -1 | tr -d "\\"'")
		if [[ -z "$project" ]]; then
			for f in "\${files[@]}"; do
				n=$(sed -n 's/^name: *//p' "$f" | head -1)
				[[ -n "$n" ]] && project="$n"
			done
		fi
		[[ -n "$project" ]] || project=$(basename "$PWD")
		if [[ $discovered == 1 && -n "\${FAKE_COMPOSE_DISCOVERED_NAME:-}" ]]; then
			project="$FAKE_COMPOSE_DISCOVERED_NAME"
		fi
		project=$(printf '%s' "$project" | tr '[:upper:]' '[:lower:]')
		rename=""
		[[ $discovered == 1 ]] && rename="\${FAKE_COMPOSE_DISCOVERED_VOLUME:-}"
		volumes=$(awk -v p="$project" -v rename="$rename" '
			/^[^ ]/ { in_v = ($0 == "volumes:"); next }
			in_v && /^  [^ ]/ { key = $1; sub(/:$/, "", key); if (!(key in name)) { order[++n] = key; name[key] = p "_" key }; next }
			in_v && /^    name: / { name[key] = $2 }
			END {
				if (split(rename, r, "=") == 2) name[r[1]] = r[2]
				for (i = 1; i <= n; i++) print order[i], name[order[i]]
			}' "\${files[@]}")
		case "$1" in
			config)
				echo "name: $project"
				echo "services: {}"
				echo "volumes:"
				while read -r key name; do
					[[ -n "$key" ]] && printf '  %s:\\n    name: %s\\n' "$key" "$name"
				done <<<"$volumes"
				;;
			up|down)
				echo "$project $(cut -d' ' -f2 <<<"$volumes" | tr '\\n' ' ')" >> "$FAKE_DOCKER_ROOT/$1.log"
				;;
		esac
		;;
	ps)
		if [[ -n "\${FAKE_DOCKER_PS:-}" ]]; then
			if [[ -z "\${FAKE_DOCKER_PS_FILTER:-}" || "$line" =~ $FAKE_DOCKER_PS_FILTER ]]; then
				echo "$FAKE_DOCKER_PS"
			fi
		fi
		;;
	volume)
		name="\${@: -1}"
		labels="$FAKE_DOCKER_ROOT/labels"
		case "$2" in
			inspect)
				[[ -d "$vols/$name" ]] || { echo "no such volume: $name" >&2; exit 1; }
				if [[ "$3" == --format ]]; then
					key=""
					if [[ -f "$labels/$name" ]]; then
						key=$(sed -n 's/^com.docker.compose.volume=//p' "$labels/$name")
					elif [[ "$name" == *_* ]]; then
						key="\${name#*_}"
					fi
					echo "\${key:-<no value>}"
				fi
				;;
			create)
				mkdir -p "$vols/$name" "$labels"
				: > "$labels/$name"
				while [[ $# -gt 1 ]]; do
					[[ "$1" == --label ]] && printf '%s\\n' "$2" >> "$labels/$name"
					shift
				done
				;;
			rm) rm -rf "\${vols:?}/$name" "$labels/$name" ;;
			ls)
				project="\${name#label=com.docker.compose.project=}"
				for d in "$vols"/*; do
					[[ -d "$d" && "$d" != *-pre-restore-* ]] || continue
					v=$(basename "$d")
					if [[ -f "$labels/$v" ]]; then
						grep -qxF "com.docker.compose.project=$project" "$labels/$v" && echo "$v"
					elif [[ "$v" == "$project"_* ]]; then
						echo "$v"
					fi
				done
				;;
		esac
		;;
	run)
		shift
		points=(); hosts=()
		while [[ "$1" != busybox:latest ]]; do
			if [[ "$1" == -v ]]; then
				src="\${2%%:*}"; rest="\${2#*:}"; point="\${rest%%:*}"
				if [[ "$src" == /* ]]; then host="$src"; else host="$vols/$src"; mkdir -p "$host"; fi
				points+=("$point"); hosts+=("$host")
				shift 2
			else
				shift
			fi
		done
		shift
		args=()
		for a in "$@"; do
			for i in "\${!points[@]}"; do
				p="\${points[$i]}"
				if [[ "$a" == "$p" || "$a" == "$p"/* ]]; then a="\${hosts[$i]}\${a#"$p"}"; break; fi
			done
			args+=("$a")
		done
		"\${args[@]}" || exit $?
		;;
esac
if [[ $fail_after == 1 ]]; then
	echo "fake docker: injected failure after running" >&2
	exit 1
fi
exit 0
`;

export interface Result {
	readonly code: number;
	readonly out: string;
	readonly calls: string[];
}

/** A machine with the fake docker: an install directory and its volumes. */
export interface Host {
	readonly root: string;
	readonly dir: string;
	/** The directory holding the volume called `name`. */
	readonly volumeDir: (name: string) => string;
	/** Creates the volume `name` with the labels Compose gives `key` of `project`. */
	readonly composeVolume: (name: string, key: string, project: string) => Promise<string>;
	readonly volumeNames: () => Promise<string[]>;
	readonly env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
	readonly calls: () => Promise<string[]>;
	/** Every `docker compose up` so far: the project and the volumes it mounts. */
	readonly ups: () => Promise<{ project: string; volumes: string[] }[]>;
	/** Runs `bash <script> ...args` in the install directory. */
	readonly script: (
		script: string,
		args: string[],
		env?: Record<string, string>
	) => Promise<Result>;
}

export async function makeHost(composeFile = COMPOSE_FILE): Promise<Host> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-restore-'));
	roots.push(root);
	const dir = join(root, 'install');
	const bin = join(root, 'bin');
	const vols = join(root, 'volumes');
	const log = join(root, 'docker.log');
	await mkdir(dir, { recursive: true });
	await mkdir(bin);
	await mkdir(vols);
	await writeFile(join(bin, 'docker'), FAKE_DOCKER);
	await chmod(join(bin, 'docker'), 0o755);
	await writeFile(join(dir, 'docker-compose.yml'), composeFile);
	await writeFile(log, '');

	const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
		...process.env,
		PATH: `${bin}:${process.env['PATH'] ?? ''}`,
		FAKE_DOCKER_LOG: log,
		FAKE_DOCKER_ROOT: root,
		TMPDIR: root,
		...extra,
	});
	const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean);
	return {
		root,
		dir,
		volumeDir: (name) => join(vols, name),
		async composeVolume(name, key, project) {
			await mkdir(join(vols, name), { recursive: true });
			await mkdir(join(root, 'labels'), { recursive: true });
			await writeFile(
				join(root, 'labels', name),
				`com.docker.compose.project=${project}\ncom.docker.compose.volume=${key}\n`
			);
			return join(vols, name);
		},
		volumeNames: async () => (await readdir(vols)).sort(),
		env,
		calls,
		async ups() {
			const path = join(root, 'up.log');
			if (!existsSync(path)) return [];
			return (await readFile(path, 'utf8'))
				.split('\n')
				.filter(Boolean)
				.map((entry) => {
					const [project = '', ...volumes] = entry.trim().split(/\s+/);
					return { project, volumes };
				});
		},
		async script(script, args, extra = {}) {
			await writeFile(log, '');
			try {
				const r = await run('bash', [script, ...args], { cwd: dir, env: env(extra) });
				return { code: 0, out: r.stdout + r.stderr, calls: await calls() };
			} catch (error) {
				const failure = error as { code?: number; stdout?: string; stderr?: string };
				return {
					code: failure.code ?? 1,
					out: (failure.stdout ?? '') + (failure.stderr ?? ''),
					calls: await calls(),
				};
			}
		},
	};
}

/** The timestamp `stubDate` makes backup.sh and restore.sh name their files with. */
export const FIXED_STAMP = '20260101-000000';

/**
 * Pins the second-resolution timestamp both scripts name their outputs by, so
 * a test can put a file at that name first. Every other `date` call runs as
 * usual.
 */
export async function stubDate(host: Host): Promise<void> {
	const stub = join(host.root, 'bin', 'date');
	await writeFile(
		stub,
		`#!/usr/bin/env bash\nif [[ "$*" == *"%Y%m%d-%H%M%S"* ]]; then echo ${FIXED_STAMP}; else exec /bin/date "$@"; fi\n`
	);
	await chmod(stub, 0o755);
}

export interface Install extends Host {
	readonly archive: string;
	/** The directory of this install's live `owlat_<suffix>` volume. */
	readonly volume: (suffix: string) => string;
	readonly run: (env?: Record<string, string>, flags?: string[]) => Promise<Result>;
	/** Starts the restore, sends `signal` once a FAKE_DOCKER_HANG call blocks. */
	readonly interrupt: (signal: NodeJS.Signals, env: Record<string, string>) => Promise<Result>;
}

type Payload = string | Buffer | { files: Record<string, string> };

export interface InstallOptions {
	readonly manifestExtra?: string;
	/** A clone with no .env and no volumes: the disaster-recovery case. */
	readonly freshHost?: boolean;
	readonly composeFile?: string;
	readonly currentEnv?: string;
	readonly archivedEnv?: string;
	readonly currentOverride?: string;
	readonly archivedOverride?: string;
	/** The install's .owlat-flags.json. */
	readonly currentFlags?: string;
	/** The archive's owlat-flags.json; omitted, the archive predates it. */
	readonly archivedFlags?: string;
	/** Restore this archive (from backup.sh) instead of building one. */
	readonly archive?: string;
	/** The archive's VOLUMES.txt; omitted, the archive predates it. */
	readonly volumeList?: string;
}

/**
 * An install with live data in convex-data and redis-data (mail-certs does
 * not exist yet) and a backup archive carrying all three volumes.
 */
export async function makeInstall(
	payloads: Record<string, Payload> = {},
	options: InstallOptions = {}
): Promise<Install> {
	const host = await makeHost(options.composeFile);
	const { root, dir } = host;
	if (!options.freshHost) await writeFile(join(dir, '.env'), options.currentEnv ?? 'CURRENT=1\n');
	if (options.currentOverride !== undefined) {
		await writeFile(join(dir, 'docker-compose.override.yml'), options.currentOverride);
	}
	if (options.currentFlags !== undefined) {
		await writeFile(join(dir, '.owlat-flags.json'), options.currentFlags);
	}

	const volume = (suffix: string) => host.volumeDir(`${PROJECT}_${suffix}`);
	for (const suffix of options.freshHost ? [] : ['convex-data', 'redis-data']) {
		await mkdir(volume(suffix), { recursive: true });
		await writeFile(join(volume(suffix), 'old.txt'), `old ${suffix}\n`);
	}

	const archive = options.archive ?? (await buildArchive(root, payloads, options));

	return {
		...host,
		archive,
		volume,
		async interrupt(signal, env) {
			await writeFile(join(root, 'docker.log'), '');
			// Its own process group, so the signal reaches the script and the
			// blocked docker call together, as a Ctrl-C in a terminal does.
			const child = spawn('bash', [RESTORE, '--yes', archive], {
				cwd: dir,
				env: host.env(env),
				detached: true,
			});
			let out = '';
			child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
			child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
			const exited = new Promise<number>((resolve) =>
				child.on('close', (code, sig) => resolve(code ?? (sig ? 128 : 1)))
			);
			const hanging = join(root, 'hanging');
			const deadline = Date.now() + 10_000;
			while (!existsSync(hanging)) {
				if (Date.now() > deadline) throw new Error(`never reached the hang point:\n${out}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			process.kill(-(child.pid ?? 0), signal);
			// A signal the script sat on fails here, with its output, not at the test timeout.
			let stuck = false;
			const watchdog = setTimeout(() => {
				stuck = true;
				process.kill(-(child.pid ?? 0), 'SIGKILL');
			}, 10_000);
			const code = await exited;
			clearTimeout(watchdog);
			if (stuck) throw new Error(`still running 10 s after ${signal}:\n${out}`);
			return { code, out, calls: await host.calls() };
		},
		run: (env = {}, flags = []) => host.script(RESTORE, ['--yes', ...flags, archive], env),
	};
}

/** Builds the archive the way backup.sh lays it out, with its sha256 sidecar. */
async function buildArchive(
	root: string,
	payloads: Record<string, Payload>,
	options: InstallOptions
): Promise<string> {
	const staging = join(root, 'staging');
	const content: Record<string, Payload> = {
		'convex-data': { files: { 'db.sqlite': 'new convex\n' } },
		'redis-data': { files: { 'appendonly.aof': 'new redis\n' } },
		'mail-certs': { files: { 'cert.pem': 'new cert\n' } },
		...payloads,
	};
	let listed = '';
	for (const [suffix, payload] of Object.entries(content)) {
		await mkdir(join(staging, suffix), { recursive: true });
		const tarPath = join(staging, suffix, 'volume.tar');
		if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
			await writeFile(tarPath, payload);
		} else {
			const src = join(root, 'src', suffix);
			await mkdir(src, { recursive: true });
			for (const [name, text] of Object.entries(payload.files)) {
				await writeFile(join(src, name), text);
			}
			await run('tar', ['-cf', tarPath, '-C', src, '.']);
		}
		listed += `  ${suffix}/volume.tar\n`;
	}
	await writeFile(join(staging, 'env'), options.archivedEnv ?? 'RESTORED=1\n');
	if (options.archivedOverride !== undefined) {
		await writeFile(join(staging, 'docker-compose.override.yml'), options.archivedOverride);
	}
	if (options.archivedFlags !== undefined) {
		await writeFile(join(staging, 'owlat-flags.json'), options.archivedFlags);
	}
	if (options.volumeList !== undefined) {
		await writeFile(join(staging, 'VOLUMES.txt'), options.volumeList);
	}
	await writeFile(
		join(staging, 'MANIFEST.txt'),
		`Owlat backup\n============\n\nProject name: ${PROJECT}\nIncludes:\n${listed}${options.manifestExtra ?? ''}  env                      — .env file\n`
	);
	const archive = join(root, 'owlat-20260101-000000.tar.gz');
	await run('tar', ['-czf', archive, '-C', staging, '.']);
	const sha = createHash('sha256')
		.update(await readFile(archive))
		.digest('hex');
	await writeFile(`${archive}.sha256`, `${sha}\n`);
	return archive;
}

/** A real tar of `files`, for payloads that are then damaged on purpose. */
export async function tarOf(files: Record<string, string>): Promise<Buffer> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-restore-tar-'));
	roots.push(root);
	await mkdir(join(root, 'src'));
	for (const [name, text] of Object.entries(files)) await writeFile(join(root, 'src', name), text);
	await run('tar', ['-cf', join(root, 'out.tar'), '-C', join(root, 'src'), '.']);
	return readFile(join(root, 'out.tar'));
}

export const isExtraction = (call: string) => call.startsWith('run ') && call.includes('tar -xf');
export const isWipe = (call: string) => call.startsWith('run ') && call.includes('rm -rf');

/** The volumes the last `docker compose up` mounted hold the archive's data. */
export async function expectStartedOnRestoredData(
	host: Host,
	project: string,
	names: Record<'convex-data' | 'redis-data' | 'mail-certs', string> = {
		'convex-data': `${project}_convex-data`,
		'redis-data': `${project}_redis-data`,
		'mail-certs': `${project}_mail-certs`,
	}
): Promise<void> {
	const up = (await host.ups()).at(-1);
	expect(up?.project).toBe(project);
	expect([...(up?.volumes ?? [])].sort()).toEqual(Object.values(names).sort());
	for (const [suffix, file, text] of [
		['convex-data', 'db.sqlite', 'new convex\n'],
		['redis-data', 'appendonly.aof', 'new redis\n'],
		['mail-certs', 'cert.pem', 'new cert\n'],
	] as const) {
		expect(await readFile(join(host.volumeDir(names[suffix]), file), 'utf8')).toBe(text);
	}
}
