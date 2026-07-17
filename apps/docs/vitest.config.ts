import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['__tests__/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
		},
	},
});
