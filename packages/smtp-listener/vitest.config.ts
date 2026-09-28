import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: {
		lines: 90,
		thresholds: { branches: 80 },
		// `smtpTestClient.ts` is the suites' own driver (see its header: it lives
		// in src/ only so apps/mta can import ONE copy). Measuring the harness
		// against the listener's coverage floor would report the harness, not
		// the listener.
		exclude: ['src/index.ts', 'src/types.ts', 'src/smtpTestClient.ts'],
	},
});
