import type { ImapCommandModule } from '../types.js';
import { syncSession } from '../helpers/session.js';

interface EnableArgs {
	/** Capability atoms the client asked to enable, upper-cased. */
	readonly requested: readonly string[];
}

/**
 * RFC 5161 ENABLE. The server has no per-connection capability bits to
 * flip (CONDSTORE etc. are always usable), but §3.2 still requires an
 * untagged `* ENABLED` line echoing the subset of requested capabilities
 * the server actually advertises — clients use it to confirm what took
 * effect. Capabilities the server does not advertise are silently
 * dropped from the echo.
 */
export const enableModule: ImapCommandModule<EnableArgs> = {
	verbs: ['ENABLE'],
	capabilities: ['ENABLE'],
	parseArgs(rawArgs) {
		return {
			ok: true,
			args: { requested: rawArgs.map((a) => a.toUpperCase()) },
		};
	},
	start({ deps, args, tag, send }) {
		// `capabilityLine` starts with the literal `CAPABILITY ` token —
		// the rest are the advertised atoms (e.g. `IMAP4rev1 CONDSTORE …`).
		const advertised = new Set(
			deps.capabilityLine
				.replace(/^CAPABILITY\s+/i, '')
				.split(/\s+/)
				.filter(Boolean)
				.map((a) => a.toUpperCase()),
		);
		const enabled = args.requested.filter((cap) => advertised.has(cap));
		send(`* ENABLED${enabled.length > 0 ? ` ${enabled.join(' ')}` : ''}`);
		send(`${tag} OK ENABLE completed`);
		return syncSession();
	},
};
