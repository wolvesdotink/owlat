/**
 * Root package scripts whose obvious meaning does damage or cannot work in
 * this repository. Each name stays, so someone who types it learns what to run
 * instead, and it exits non-zero, so nothing that chains on it carries on.
 *
 *   - `ox:fmt`: the tree predates oxfmtrc.json, so formatting all of it
 *     rewrites several hundred files a change never touched.
 *   - `dev`, `dev:api`: `convex dev` in apps/api bundles every single-dot
 *     `.ts` file under `convex/`, including the test helpers in `__tests__`
 *     that import `node:fs`, so the push fails whichever deployment it targets.
 *     `dev:stack` pushes from a stage without them.
 */

const DEV_STACK =
	'run `bun run dev:stack`: it starts a local backend for this checkout, pushes the functions without the test helpers and runs Nuxt (docs/operations/development.md).';

export const POINTERS: Record<string, string> = {
	'ox:fmt':
		'formatting the whole tree rewrites several hundred files that predate oxfmtrc.json. Format the files you changed with `./node_modules/.bin/oxfmt --config oxfmtrc.json <paths>`; `bun run lint:format` checks them.',
	dev: `\`convex dev\` from apps/api fails on the test helpers under convex/__tests__. To work on the app, ${DEV_STACK} For Nuxt alone against the deployment .env selects, run \`bun run dev:web\`.`,
	'dev:api': `\`convex dev\` from apps/api fails on the test helpers under convex/__tests__. Instead, ${DEV_STACK}`,
};

/** The line printed for `name`, or undefined when it is not one of the pointers. */
export function pointerFor(name: string): string | undefined {
	return Object.hasOwn(POINTERS, name) ? `${name}: ${POINTERS[name]}` : undefined;
}

if (import.meta.main) {
	const name = process.argv[2] ?? '';
	console.error(pointerFor(name) ?? `command-pointer: no pointer for "${name}".`);
	process.exit(1);
}
