/**
 * The vitest config for scripts/__tests__, the tests of the root gate scripts
 * (`bun run lint:script-tests`, and the direct `vitest run scripts/__tests__/…`
 * calls in the security workflow). scripts/ is not a workspace, so its suite
 * runs from the repository root and finds this file there. Every workspace runs
 * vitest from its own directory with its own config and never reads this one.
 *
 * Most of these tests run a real tool on the real repository: a gate script
 * under bash, `tsc --listFilesOnly`, `turbo --dry=json`, a child vitest run,
 * restore.sh against a fake docker. That is the fixed cost the shared budget
 * is sized for; vitest's 5000ms default failed them on a loaded CI runner.
 */
import { defineConfig } from 'vitest/config';
import { PARALLEL_GATE_TIMEOUT_MS } from './vitest.timeouts';

export default defineConfig({
	test: {
		include: ['scripts/__tests__/**/*.test.ts'],
		environment: 'node',
		testTimeout: PARALLEL_GATE_TIMEOUT_MS,
		hookTimeout: PARALLEL_GATE_TIMEOUT_MS,
	},
});
