import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		globals: false,
		coverage: packageCoverage({ lines: 96, exclude: ['test/**'] }),
	},
});
