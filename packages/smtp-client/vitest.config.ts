import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	include: ['__tests__/**/*.test.ts'],
	coverage: {
		// R2 ratchet: smtp-client meets the same >=90 line bar as the other
		// three new mail packages (U6). The long-tail quirk integration suite
		// (`__tests__/quirks.integration.test.ts`) exercises the reply framer,
		// STARTTLS refusal and mid-transaction failure paths that carry it
		// over the line. Never lower this.
		lines: 90,
	},
});
