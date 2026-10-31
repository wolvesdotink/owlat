/**
 * Command-line parsing for `bun run dev:stack`. Anything the usage line does
 * not name (an unknown flag, a stray positional, an unknown `logs` service)
 * prints the usage and exits 2 rather than being ignored.
 */

export const DEV_STACK_USAGE =
	'Usage: bun run dev:stack [up [--no-seed] | down [--volumes] | status | ports | logs [convex|redis] [--follow]]';

const SERVICES: ReadonlySet<string> = new Set(['convex', 'redis']);

const KNOWN_FLAGS: Readonly<Record<string, readonly string[]>> = {
	up: ['--no-seed'],
	down: ['--volumes'],
	status: [],
	ports: [],
	logs: ['--follow'],
};

export type DevStackArgs =
	| {
			readonly kind: 'run';
			readonly command: string;
			/** The `logs` service, when one was named. */
			readonly service: string | undefined;
			readonly flags: ReadonlySet<string>;
	  }
	/** Print the usage and exit: 0 for `--help`/`-h`, 2 for a bad invocation. */
	| { readonly kind: 'usage'; readonly exitCode: 0 | 2 };

export function parseDevStackArgs(argv: readonly string[]): DevStackArgs {
	const flags = new Set<string>();
	const positionals: string[] = [];
	for (const arg of argv) {
		if (arg.startsWith('-')) flags.add(arg);
		else positionals.push(arg);
	}
	if (flags.has('--help') || flags.has('-h')) return { kind: 'usage', exitCode: 0 };

	const [command = 'up', ...rest] = positionals;
	const allowed = KNOWN_FLAGS[command];
	if (!allowed) return { kind: 'usage', exitCode: 2 };
	const unknownFlag = [...flags].some((flag) => !allowed.includes(flag));
	const badArgs =
		command === 'logs'
			? rest.length > 1 || (rest[0] !== undefined && !SERVICES.has(rest[0]))
			: rest.length > 0;
	if (unknownFlag || badArgs) return { kind: 'usage', exitCode: 2 };
	return { kind: 'run', command, service: rest[0], flags };
}
