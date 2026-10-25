import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	// The seeded fuzz suite parses 10,000 mutated messages in one test: about
	// 300ms on an idle machine, over 12s on a runner shared with the whole
	// monorepo's release gate.
	timeout: 'parallel-gate',
	include: ['__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
	coverage: {
		// R2 ratchet (U6 doctrine): the compose side is raised to the parse
		// side's >=90 line gate now that its differential + the golden corpus
		// exercise it, and the package-wide floor U0 had to drop to 20 during
		// the restructure is restored to 90. Never lower these — measured line
		// coverage is ~99% package-wide, every compose file >=94%.
		lines: 90,
		thresholds: {
			'src/parse/**': {
				lines: 90,
			},
			'src/compose/**': {
				lines: 90,
			},
		},
		exclude: ['src/index.ts'],
	},
});
