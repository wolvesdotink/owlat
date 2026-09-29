import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: {
		lines: 67,
		// index.ts / server.ts boot the worker + HTTP server; connection.ts and
		// accountManager.ts are IMAP I/O. The pure mapping/parsing logic
		// (config, folders, ingest) is what the unit tests cover.
		exclude: ['src/index.ts', 'src/server.ts'],
	},
});
