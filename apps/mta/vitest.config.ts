import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		setupFiles: ['./vitest.setup.ts'],
		coverage: packageCoverage({
			lines: 87,
			exclude: ['src/index.ts', 'src/server.ts'],
		}),
	},
});
