/**
 * Inbound shadow-replay harness (piece C0 of the 2026-07-16 "Own the Mail"
 * plan) — public barrel.
 *
 * The harness runs each raw `message/rfc822` blob through BOTH inbound stacks —
 * the OLD library stack (mailparser + mailauth) and the NEW in-house stack
 * (`@owlat/mail-message`'s `parseMessage` + `@owlat/mail-auth`'s `verifyDkim`)
 * — projects each onto the ROUTING / DELIVERY DRIVERS the six inbound consumers
 * actually read (parsed fields + DKIM/SPF/DMARC verdicts), and does a
 * FIELD-LEVEL diff. Any message whose drivers diverge is saved to a regression
 * corpus so the divergence can be replayed into the P3 (parse) and A2
 * (DKIM/canon) differential suites.
 *
 * The implementation is split into cohesive siblings under `replay/`:
 *   - `replay/drivers.ts`  — the consumed-field projection (bodies -> digests).
 *   - `replay/diff.ts`     — divergence + sanction classification.
 *   - `replay/stacks.ts`   — the in-house stack + DKIM tag extraction.
 *   - `replay/report.ts`   — the replay engine + report shape.
 *   - `replay/corpusIo.ts` — corpus load / regression save / report render.
 *
 * DESIGN — WHY THE OLD STACK IS INJECTED, NOT IMPORTED HERE (I1 / I3):
 *   mailparser and mailauth survive ONLY as differential oracles and are being
 *   excised from the MTA's runtime deps by later pieces. So this shipped tool
 *   imports ONLY the permanent in-house packages for the NEW stack
 *   (`owlatNewStack`); the OLD (oracle) stack is passed in by the caller (the CI
 *   test wires it, an operator wires it for a real-mail run). That keeps the
 *   harness reusable AND keeps the oracle imports where I1 requires them.
 *
 * BODY SAFETY (I7 — the harness NEVER logs decoded bodies): the driver
 * projection reduces every body / attachment payload to a SHA-256 digest +
 * length BEFORE it enters a `RoutingDrivers` record, so no decoded body text
 * ever reaches a divergence record, the formatted report, or the JSON
 * divergence log. Only `saveDivergent` writes raw bytes, and it writes them to
 * the regression-corpus `.eml` (the message under test), never to a log.
 *
 * OPERATIONAL USE: point `loadCorpus` at a directory of sampled + scrubbed real
 * stored mail from a dev deployment (an operator step done pre-cutover), wire
 * the oracle stack, and feed `runReplay`'s report into `saveDivergent`. The CI
 * test runs the same engine over the small checked-in slice only.
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
