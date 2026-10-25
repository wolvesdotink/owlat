/**
 * The generator half of `check-handler-size.sh`: prints one ratchet entry per
 * Convex handler longer than the cap (see `lib/handlerSize.ts` for how a
 * handler is found and measured).
 *
 *   bun scripts/handler-size-census.ts            ratchet entries, `<module>:<name> <lines>`
 *   bun scripts/handler-size-census.ts --top <n>  the n longest, `<lines> <module>:<name>`
 *   bun scripts/handler-size-census.ts --stdin <module>
 *                                                 the census of one module read from stdin, as
 *                                                 JSON `{ handlers, problems }` (how the gate's
 *                                                 own tests drive it)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { byLength, censusLines, censusModule, type HandlerSize } from './lib/handlerSize';
import { productionModules } from './lib/sourceGraph';

/**
 * Handlers longer than this many lines are listed in the baseline with their
 * length. It was set to the length of the eleventh-longest handler, so the
 * baseline started with the ten longest. Lower it as they shrink; never raise it.
 */
const HANDLER_LINE_CAP = 180;

const apiRoot = join(import.meta.dirname, '..');

/** Modules are named relative to apps/api (`convex/mail/draftSend.ts`). */
const readModule = (module: string): string | undefined => {
	const path = join(apiRoot, module);
	return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

const stdinModule = process.argv.indexOf('--stdin');
if (stdinModule !== -1) {
	const module = process.argv[stdinModule + 1] ?? 'convex/stdin.ts';
	console.info(JSON.stringify(censusModule(module, readFileSync(0, 'utf8'), readModule)));
	process.exit(0);
}
const handlers: HandlerSize[] = [];
const problems: string[] = [];
for (const file of productionModules(join(apiRoot, 'convex'))) {
	const module = relative(apiRoot, file).split('\\').join('/');
	const census = censusModule(module, readFileSync(file, 'utf8'), readModule);
	handlers.push(...census.handlers);
	problems.push(...census.problems);
}

// A parser that stopped recognising the builders would report an empty set,
// which the ratchet would read as every long handler fixed.
if (handlers.length < 500)
	problems.push(`found only ${handlers.length} Convex handlers under convex/`);
if (problems.length > 0) {
	for (const problem of problems) console.error(`FAIL: ${problem}`);
	process.exit(1);
}

const top = process.argv.indexOf('--top');
if (top !== -1) {
	const limit = Number(process.argv[top + 1] ?? 10);
	for (const handler of byLength(handlers).slice(0, limit)) {
		console.info(`${handler.lines} ${handler.module}:${handler.name}`);
	}
} else {
	for (const line of censusLines(handlers, HANDLER_LINE_CAP)) console.info(line);
}
