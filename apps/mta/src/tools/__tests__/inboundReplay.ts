/**
 * Inbound shadow-replay harness — test-only barrel.
 *
 * Runs each raw `message/rfc822` blob through both inbound stacks — the old
 * library stack (mailparser + mailauth, injected by the caller so it never
 * becomes an MTA runtime dep) and the in-house stack (`@owlat/mail-message`
 * `parseMessage` + `@owlat/mail-auth` `verifyDkim`) — projects each onto the
 * routing / delivery drivers the inbound consumers read, and diffs them field
 * by field. Divergent messages can be saved to a regression corpus.
 *
 * Bodies never reach a report: the driver projection reduces every body and
 * attachment payload to a SHA-256 digest + length first. Only `saveDivergent`
 * writes raw bytes, and only to the regression-corpus `.eml`.
 *
 * Siblings under `replay/`: drivers (projection), diff (divergence +
 * sanction classification), stacks (in-house stack + DKIM tag extraction),
 * report (engine + report shape), corpusIo (corpus load / save / render).
 */

export type {
	DriverAddress,
	DriverAttachment,
	DriverBody,
	HeaderLookup,
	ParsedLike,
	RoutingDrivers,
} from './replay/drivers.js';
export { projectDrivers } from './replay/drivers.js';

export type {
	AuthVerdicts,
	DkimContext,
	Divergence,
	DivergenceCategory,
	SanctionedFields,
	SanctionKind,
} from './replay/diff.js';
export { diffAuth, diffDrivers } from './replay/diff.js';

export type {
	DkimCorpusHint,
	ReplayEnvelope,
	ReplayInput,
	ReplayStacks,
	ReplayStackSide,
} from './replay/stacks.js';
export { owlatNewStack, resolverFromHint } from './replay/stacks.js';

export type { MessageReplayResult, ReplayReport } from './replay/report.js';
export { runReplay } from './replay/report.js';

export { formatReport, loadCorpus, saveDivergent } from './replay/corpusIo.js';
