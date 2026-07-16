export const meta = {
	name: 'own-the-mail-prs',
	description:
		'Auto-merging per-piece PR pipeline for the 2026-07-16 UNIFIED "Own the Mail" plan — the merge of "Owning the Wire" (nodemailer removal, old PR #358) and "Own the Inbound" (smtp-server/mailparser/mailauth removal, old PR #357) into ONE pipeline, ONE integration branch (integration/own-the-mail), ONE giant human-merged PR. Flow per piece: a BUILDER thread (Opus) implements it IN A DEDICATED GIT WORKTREE with atomic commits and opens a PR against the integration branch; GitHub Actions verifies the push; ONE unified reviewer thread (Fable, per-review fallback to Opus) reviews Security + Code Quality + Functionality/Tests + the Fowler code-smell catalog + per-stack best practices AND ENFORCES THE HARD TEST GATE; the AUTHOR thread (Opus) loops addressing EVERY finding — small improvements included — until the reviewer posts APPROVE; then, on APPROVE + green CI, a MERGE thread (Sonnet) squash-merges the piece into the integration branch and the next piece in its track starts. Waves are barriers; tracks within a wave run in parallel; pieces within a track run serially. Wave 1 lands the five in-flight PRs (#360 S2, #361 M2, #362 P2, #363 A2, #364 L2) into their OLD integration branches; a SEED step then merges both old branches into integration/own-the-mail (6 known conflicts), opens the new aggregate draft PR, and closes #357/#358; U0 restructures the unified packages/mail-message (parse/ + compose/); the remaining pieces build engines, cut over all six call sites, excise all four libraries, and optionally add X1-X4 capabilities. After each post-seed wave, main is merged INTO the integration branch (trunk wins). F1 opens the giant PR main <- integration/own-the-mail and STOPS at approved + green — Marcel squash-merges it by hand. The pipeline NEVER merges to main.',
	phases: [
		{
			title: 'Build',
			detail: 'Opus builders open PRs vs integration/own-the-mail from dedicated scratchpad worktrees',
			model: 'opus',
		},
		{ title: 'Verify', detail: 'wait for GitHub Actions CI (gh pr checks)' },
		{
			title: 'Review',
			detail:
				'one unified reviewer per PR (security + quality + functionality + TEST GATE + smells + best practices)',
			model: 'fable',
		},
		{
			title: 'Address',
			detail: 'Opus author fixes every finding, small improvements included',
			model: 'opus',
		},
		{
			title: 'Merge',
			detail: 'APPROVE verdict + CI green -> Sonnet squash-merge into the integration branch (never main)',
			model: 'sonnet',
		},
		{
			title: 'Seed',
			detail: 'after wave 1: merge both old integration branches into integration/own-the-mail',
			model: 'opus',
		},
		{
			title: 'Sync',
			detail: 'after each post-seed wave: merge main INTO integration/own-the-mail (trunk wins)',
			model: 'opus',
		},
	],
};

// ===========================================================================
// Constants
// ===========================================================================
const REPO = 'wolvesdotink/owlat'; // the `origin` remote for this checkout
const BASE = 'integration/own-the-mail'; // piece PRs target THIS branch (never main); created by SEED
const INBOUND = 'integration/own-the-inbound'; // old branch — wave-1 inbound pieces still land here
const WIRE = 'integration/own-the-wire'; // old branch — wave-1 wire pieces still land here
const MAIN = 'main'; // merged INTO the integration branch after each wave; F1's final target
const OLD_AGG_INBOUND = 357; // old aggregate PR (closed by SEED)
const OLD_AGG_WIRE = 358; // old aggregate PR (closed by SEED)
const MAX_ROUNDS = 4; // review<->address rounds before escalating to a human
const CI_POLLS = 18; // bounded CI-wait iterations (~120s each); this repo's full matrix + Docker builds can exceed ~16 min
const ROOT = '/home/marcel/Code/Owlat';
const SCRATCH =
	'/tmp/claude-1000/-home-marcel-Code-Owlat/0a4fb530-b8e3-4b88-9c6b-e83d2d3fb71f/scratchpad/otm-wt';
const AUTO_MERGE = true; // squash-merge into the INTEGRATION branch on approve+green (F1 excepted — human-merged)
const MERGE_ATTEMPTS = 3; // merge tries per piece; a conflict spawns an Opus resolver between tries
const ABORT_IF_WHOLE_WAVE_FAILS = true;

// ===========================================================================
// THE PRODUCT BRIEF — shared by every builder/reviewer so all PRs converge on
// ONE migration. Decisions come from the two reviewed 2026-07-11 plans PLUS the
// 2026-07-16 unification decisions (own-the-mail-unified-plan.md on Marcel's
// desktop). Deviations are review-blocking.
// ===========================================================================
const BRIEF =
	`PRODUCT BRIEF — "Own the Mail" (unified 2026-07-16 plan: one in-house mail stack, both directions):\n` +
	`GOAL: production runs ZERO third-party mail libraries. OUTBOUND (from "Owning the Wire"): nodemailer's two jobs move to packages/mail-message (compose/ — composeMessage(input) -> { raw, messageId, envelope }, RFC 2047 encoding/folding, QP/base64, attachments, plus signMessage(raw, key) DKIM-over-bytes) and packages/smtp-client (explicit state machine over net/tls: connect/secured/capabilities, send with per-recipient RCPT verdicts, SmtpError { phase, replyCode?, enhancedCode?, secured, tlsCause? }); tlsSecuredCapture.ts, classifyTlsFailure's string tables, and classifySmtpError's message sniffing get DELETED, not adapted. INBOUND (from "Own the Inbound"): smtp-server -> packages/smtp-listener, mailparser -> packages/mail-message (parse/ — parseMessage(raw): ParsedMessage with the full consumed-field contract), mailauth -> packages/mail-auth (SPF/DMARC/DKIM verify + canon + cached DNS), with byte-for-byte-equivalent behavior except enumerated, signed-off improvements.\n` +
	`UNIFICATION DECISIONS (locked 2026-07-16; the whole point of this pipeline — deviations are blocking):\n` +
	`U1. ONE integration branch: ${BASE} = merge of ${INBOUND} + ${WIRE}. One aggregate PR replaces old #${OLD_AGG_INBOUND}/#${OLD_AGG_WIRE}.\n` +
	`U2. Nothing already built is discarded: the five in-flight PRs land first in their old pipelines; the SEED merge carries every merged piece over.\n` +
	`U3. ONE packages/mail-message with TWO subtrees: src/parse/* (inbound tree) + src/compose/* (wire tree, relocated in U0). index.ts is the union (verified collision-free). Subpath exports are DIRECTIONAL: ./parse/headers and ./compose/headers — the ambiguous ./headers subpath is retired (packages/shared/src/mailMime.ts consumes the PARSE one).\n` +
	`U4. ONE CANON, in packages/mail-auth (src/canon.ts, from A2/PR #363 — public, exported, relaxed+simple, header+body, mailauth-vector-pinned). The outbound signer consumes it via the pure subpath @owlat/mail-auth/canon (no dns/Redis imports). NO SECOND CANONICALIZATION IS EVER WRITTEN — a diff introducing one is an automatic request_changes. Old pieces M3 (wire) + A3 (inbound) are merged into piece MD1.\n` +
	`U5. ONE address model: the parse-side EmailAddress/AddressObject types are shared; encodeAddressHeader (compose) round-trips against parseAddressObject (pinned by test).\n` +
	`U6. Coverage doctrine (inbound's) applies package-wide: >=90% line on smtp-listener/mail-message/mail-auth; BRANCH coverage enforced on DKIM verify, canon, the listener command loop, the byte budget. smtp-client targets the same bar. The CI matrix includes ALL FOUR new packages (smtp-listener was missing — U0/SEED fixes that).\n` +
	`LOCKED DECISIONS INHERITED FROM "OWNING THE WIRE" (outbound):\n` +
	`W1. mail-message is pure and Convex-'use node'-safe (runtime deps: node:crypto + the pure @owlat/mail-auth/canon subpath ONLY; nodemailer + mailparser survive ONLY as devDependencies for differential/golden tests); smtp-client is node-only.\n` +
	`W2. Body encoding ALWAYS 7-bit safe (QP/base64), permanently — no 8BITMIME on the client, ever. Compose ONCE per job; byte-identical across MX retries (DKIM-stable). Deterministic given seeded boundary/date inputs.\n` +
	`W3. The migration preserves one-connection-per-send semantics; true RSET socket reuse is X1 ONLY.\n` +
	`W4. AUTH PLAIN + LOGIN in v1, ONLY after \`secured\` unless loopback (enforced IN THE CLIENT before credentials serialize). XOAUTH2 is X4. CRAM-MD5/DIGEST-MD5: never.\n` +
	`W5. Sequential command/reply in v1; PIPELINING is X2, capability-gated, semantics-identical.\n` +
	`W6. Envelope domains IDN-punycoded, non-ASCII localparts rejected at composition (today's behavior); SMTPUTF8/EAI is X3, fail-closed.\n` +
	`W7. STRING-MATCHING ON ERROR MESSAGES IS BANNED in new code — classify on SmtpError.phase/.tlsCause/reply codes.\n` +
	`W8. SEMANTICS-PRESERVING: TLS-RPT result types (truthfulness is non-negotiable — cleartext success records starttls-not-supported, never success; enforce-mode cert failures reach sts-webpki-invalid), the EmailErrorCode taxonomy (AMBIGUOUS_TIMEOUT: phase data/data-final with no reply is NEVER auto-retried; smtpReplyCodeToErrorCode survives unchanged), 4xx/5xx/5.2.2 bounce classification, MTA-STS enforce/testing behavior, per-IP EHLO names, VERP envelopes, pool keying + Redis cap accounting — all PROVABLY unchanged.\n` +
	`LOCKED DECISIONS INHERITED FROM "OWN THE INBOUND":\n` +
	`I1. THE FOUR ORACLES STAY FOREVER as devDependencies: nodemailer (compose differential), mailparser (parse differential), mailauth (DKIM/canon oracle), smtp-server (listener parity + fake-MX peer). Deleting them from tests makes the tests self-referential — never do it. Our code NEVER verifies itself alone.\n` +
	`I2. SEMANTICS-PRESERVING BY DEFAULT: every intended behavior change is enumerated in a fixture and individually signed off, NEVER silent. Sanctioned improvements are exactly: (a) DKIM \`l=\` tag IGNORED -> verdict capped at NEUTRAL (append-attack defense); (b) corrected per-part charset decoding; (c) corrected/real SMTP enhanced status codes; (d) rsa-sha1 verified-but-policy-fail; (e) explicit AckAndSwallowErrors naming; (f) verdict-equivalent DNS caching. Anything else diverging from the old library is a defect.\n` +
	`I3. NO BACK-COMPAT SHIMS: the old path is deleted in the SAME piece that replaces it. No dual-run flags, no dead branches "just in case".\n` +
	`I4. THE BYTE BUDGET IS LOAD-BEARING: the listener ports apps/mta/src/lib/dataStream.ts semantics exactly (buffer -> drain-past-limit -> destroy at 4x); every stall closed by the right timeout; hostile input bounded, never a crash/DoS/forged-auth pass.\n` +
	`I5. AUTH & TLS INVARIANTS: STARTTLS upgrade does a FULL state reset (RFC 3207); the exact cipher policy of today's listeners preserved (TLSv1.2 floor, AEAD-only ECDHE, honorCipherOrder, SNI); AUTH refused pre-TLS; NO auth oracle (failures byte-identical).\n` +
	`I6. DKIM VERIFIER NEVER THROWS: internal error -> temperror; multi-signature strongest-wins matches inboundDkim.pickVerdict; our signer's output must verify pass (and vice versa — the in-repo three-way with mailauth).\n` +
	`I7. THE REPLAY HARNESS NEVER LOGS DECODED BODIES: C0 diffs routing/delivery drivers only; CI runs a non-sensitive checked-in slice; real-mail replay is an operator step. CI1/CI3/CI4 are gated on a clean replay report (or every divergence individually signed off).\n` +
	`I8. Rate limiting stays in inboundSecurity.ts/submissionSecurity.ts — the listener exposes hook points only.\n` +
	`THE "EVERYTHING TESTED" CONTRACT: every piece card names its test surfaces under TESTS — that list is the merge gate. Unit / Integration (real net/tls, runtime openssl certs, ioredis-mock, in-process smtp-server) / Differential (vs the oracle library) / Replay (C0 gates cutovers) / Adversarial-hostile / Regression-golden corpora, as the card says. vitest ONLY (never bun test); no real external network in tests.\n` +
	`PRE-PROD POSTURE: clean breaking changes over back-compat ceremony; delete dead code your change orphans; no speculative seams; clean public package APIs; deep cross-package imports forbidden (check-cross-package-imports).`;

// ===========================================================================
// THE UNIFIED REVIEWER — one agent covers Security + Code Quality +
// Functionality/Tests (incl. the HARD TEST GATE) + the code-smell catalog +
// per-stack best practices.
// ===========================================================================
const SMELLS =
	`CODE-SMELL CATALOG — walk the diff against EVERY entry; report each hit with file:line and the prescribed fix:\n` +
	`- Mysterious Name — a function, variable, or type whose name doesn't reveal what it does or holds. -> rename it; if no honest name comes, the design's murky.\n` +
	`- Duplicated Code — the same logic shape appears in more than one hunk or file in the change. -> extract the shared shape, call it from both.\n` +
	`- Feature Envy — a method that reaches into another object's data more than its own. -> move the method onto the data it envies.\n` +
	`- Data Clumps — the same few fields or params keep travelling together (a type wanting to be born). -> bundle them into one type, pass that.\n` +
	`- Primitive Obsession — a primitive or string standing in for a domain concept that deserves its own type. -> give the concept its own small type.\n` +
	`- Repeated Switches — the same switch/if-cascade on the same type recurs across the change. -> replace with polymorphism, or one map both sites share.\n` +
	`- Shotgun Surgery — one logical change forces scattered edits across many files in the diff. -> gather what changes together into one module.\n` +
	`- Divergent Change — one file or module is edited for several unrelated reasons. -> split so each module changes for one reason.\n` +
	`- Speculative Generality — abstraction, parameters, or hooks added for needs the spec doesn't have. -> delete it; inline back until a real need shows.\n` +
	`- Message Chains — long a.b().c().d() navigation the caller shouldn't depend on. -> hide the walk behind one method on the first object.\n` +
	`- Middle Man — a class or function that mostly just delegates onward. -> cut it, call the real target direct.\n` +
	`- Refused Bequest — a subclass or implementer that ignores or overrides most of what it inherits. -> drop the inheritance, use composition.\n`;

const BEST_PRACTICES =
	`PER-STACK BEST PRACTICES — hold the diff to the idioms of each stack it touches:\n` +
	`- TypeScript strict: this repo runs tsconfig strict + noUncheckedIndexedAccess + noPropertyAccessFromIndexSignature. Discriminated unions over boolean flags (SmtpError.phase/tlsCause ARE discriminants — exploit them); as-const/satisfies where they tighten types; no new \`any\` (unknown + narrowing); no non-null assertions where a guard is honest; bracket-and-narrow every index-signature / dynamic-key access (the TS4111 trap); guard every array/Map/object lookup (can be undefined); narrow at the boundary, not at every use site; remove EVERY unused import/var/param (oxlint fails on these).\n` +
	`- Node sockets, CLIENT side (smtp-client): every socket path handles 'error'+'close'+'timeout' without leaking listeners or FDs; write() backpressure honored (false -> wait for 'drain'); every timer cleared on every exit path; racing socket events must not produce unhandled rejections or double-settled promises; destroy() vs end() chosen deliberately.\n` +
	`- Node raw net/tls, LISTENER side (smtp-listener): NO unbounded buffers — honor the byte budget (buffer -> drain-past-limit -> destroy at 4x); every phase has the right timeout (greeting/command/data/tls-handshake); backpressure honored; work on Buffers not strings for byte-exact SMTP grammar; destroy on limit breach; never throw out of the command loop on hostile input. STARTTLS full state reset; cipher policy (TLSv1.2 floor, AEAD-only ECDHE, honorCipherOrder, SNI) preserved verbatim.\n` +
	`- Protocol code: the state machine is explicit (no implicit state in closures scattered across callbacks); parsers tolerant in what they accept, strict in what they emit; every deliberate RFC deviation carries a comment citing the RFC section; CRLF discipline everywhere (bare LF normalized, never emitted).\n` +
	`- Package design: the four new packages expose clean public APIs (canon is public per U4); NO deep cross-package imports (oracle-library internals survive in TESTS only — check-cross-package-imports must stay green); the old libraries appear ONLY as devDependencies of differential tests; new packages mirror packages/shared's conventions (package.json name/exports, tsconfig, vitest config); bun.lock regenerated (never hand-edited) in the same commit as any package.json dependency change, only in pieces that sanction it.\n` +
	`- Convex (CW2, CI1's wire shape, any convex-adjacent work): follow apps/api/convex/CONVENTIONS.md; 'use node' actions only where net/crypto requires; env only via lib/env.ts (lint:env blocks direct process.env; MTA-side vars via apps/mta/src/config.ts); preserve the exact Convex wire shapes (body cap, synthetic Message-ID fallback, partIndex ordering, address .text).\n` +
	`- Vitest: test behavior not implementation; deterministic (no real timers where fake ones do; NO external network — in-process servers on ephemeral ports; integration tests may use real net/tls with runtime-generated openssl certs and ioredis-mock); differential tests keep the oracle library as a devDependency and assert equality of every consumed field / verdict; table-driven where cases repeat; small fixed keys/fixtures so crypto suites stay fast; fixtures checked in as bytes; integration tests clean up sockets/servers in afterEach so suites don't hang.\n` +
	`- Email / SMTP / DKIM correctness & security: header folding never splits a multi-byte UTF-8 sequence or exceeds RFC 2047's 75-octet encoded-word cap; every emitted line <= 998 octets (RFC 5322); DKIM canonicalization fold-stable; the verifier NEVER throws (internal error -> temperror); constant-time comparison for signatures/MACs where the stdlib offers it; \`l=\` tag ignored -> verdict capped neutral; hostile TXT key-record parsing bounded; SPF resolver budget counts resolver calls NOT cache hits; DNS cache respects record TTL (cap 1h), negative-caches NXDOMAIN (5min), FAILS OPEN when Redis is down; no AUTH oracle (generic byte-identical failures); key material, credentials, and decoded message bodies never logged.\n`;

const REVIEWER_FOCUS =
	`0) HARD TEST GATE (check FIRST): the piece card names its test surfaces under TESTS. The PR must ADD or EXTEND every named test surface — including DIFFERENTIAL (equality vs the oracle library), ADVERSARIAL/hostile, INTEGRATION (real net/tls where the card says), REPLAY, and GOLDEN corpora as applicable. If any named test file/extension is missing, the verdict is request_changes REGARDLESS of code quality — say exactly which named tests are missing. Tests must be vitest (never bun test), deterministic, and must actually assert the card's claims (a differential test that does not compare against the oracle, or an "adversarial" test that never checks a bound/timeout, does NOT satisfy the gate). Coverage is a gate on the new packages: touching DKIM verify / canon / command loop / byte budget without branch-covering tests is a blocking finding.\n\n` +
	`1) SECURITY: this pipeline rewrites BOTH directions of the mail path — the bar is maximal. ` +
	`OUTBOUND — CRLF/header injection: EVERY parameterized SMTP command and every composed header value must guard CRLF injection BEFORE serialization; attacker-controlled subjects/addresses/filenames/extra headers must not smuggle commands or headers. TLS fail-closed: requireTls NEVER falls back to plaintext; STARTTLS-stripping -> tlsCause 'starttls-unavailable'; the mail-sync loopback-only plaintext exception preserved EXACTLY (no widening). AUTH: credentials only after \`secured\` (or loopback), refused BY THE CLIENT before serialization; credentials/keys never logged. DOUBLE DELIVERY (highest-severity regression class): any path where a post-DATA ambiguous failure (phase data/data-final, no reply) could be classified retryable is BLOCKING. TLS-RPT truthfulness: recorded result types feed RFC 8460 reports sent to other mail operators. DKIM: signatures verified by mailauth (independent implementation) in tests — never self-verified only. ` +
	`INBOUND — LISTENER (L-pieces, CI2, CI4): the command loop must be BOUNDED — byte budget enforced (buffer -> drain -> destroy at 4x), every stall closed by the right timeout, every hostile case bounded (slowloris per phase, oversized line, NUL, early disconnect per state, TLS-handshake abandonment, flood vs maxClients, pipelining desync) — assert via budget counters / the correct timeout firing, never "it didn't crash". STARTTLS FULL STATE RESET (a MAIL FROM before the upgrade must NOT survive it); cipher policy preserved; AUTH refused pre-TLS with NO auth oracle. ` +
	`PARSER (P-pieces, CI1): hostile inputs bounded and NEVER throw (1000-part bomb, 64-deep nesting, boundary-in-base64, headers-only, mixed CRLF/LF); charset decode cannot crash; no unbounded allocation. ` +
	`AUTH (A2/MD1/CI3): the DKIM verifier NEVER throws (-> temperror); \`l=\` capped NEUTRAL (verify it is enforced, not merely intended); strongest-wins matches inboundDkim.pickVerdict; hostile TXT parsing bounded; signature-header injection / CRLF smuggling / 10k-signature bomb bounded; SPF budget counts resolver calls not cache hits; DNS cache fails open on Redis-down; NO fail-open that lets a forged signature pass. ` +
	`REPLAY (C0): the harness must NEVER log decoded bodies or plaintext — look for it explicitly. ` +
	`CANON (U4): if the diff introduces ANY second implementation of DKIM canonicalization outside packages/mail-auth/src/canon.ts, that is an automatic request_changes.\n\n` +
	`2) CODE QUALITY: The diff must CONFORM TO THE SHARED PRODUCT BRIEF (U1-U6, W1-W8, I1-I8): semantics-preserving by default — every divergence from the old library is either an enumerated, fixture-pinned, signed-off improvement or a defect; NO back-compat shims — the old path is deleted in the SAME piece; the four oracles remain devDependencies; string-matching on error messages banned in new code; no capability creep (no socket reuse before X1, no PIPELINING before X2, no EAI before X3, no runtime migration flags). ` +
	`Strict TS (no new \`any\`, TS4111-safe index access); dead code deleted not commented out; focused diff (no drive-by refactors outside the piece scope); bun.lock touched only by pieces that sanction it, and only regenerated. ` +
	`Commits are small and ATOMIC (package scaffold / logic / cutover / tests / docs separated) with conventional messages, and carry NO AI/Claude attribution of any kind.\n\n` +
	`3) FUNCTIONALITY & TESTS: The piece genuinely delivers its spec and the DIFFERENTIAL/REPLAY equality it claims — parser consumed-field equality vs mailparser (divergences = 0 on consumed fields), compose parsed-equality vs nodemailer's MailComposer, DKIM verdict equality vs mailauth, canon byte-identity, listener reply-sequence parity vs smtp-server, the categorizeError table case-identical. Nothing that worked before is broken: the existing MTA outbound suites (sender, connectionPool, TLS-RPT scenarios, dkimSign e2e), the bounce/inbound suites (pipeline, parser, classifier, outcome, effects, fblProcessor, verp, phases, server, submissionServer, bannerEhlo), the mail-sync send/tls/ingest suites, and the API categorizeError table stay green — REWRITTEN ONLY where they asserted a replaced library's internals; verify the PR did NOT gut existing assertions to make them pass. ` +
	`GitHub Actions is the source of truth for compile + test: check \`gh pr checks <num> --repo ${REPO}\`. BLOCK on FAILED checks; do NOT block solely because checks are pending/queued.\n\n` +
	`4) CODE SMELLS:\n${SMELLS}\n` +
	`5) BEST PRACTICES:\n${BEST_PRACTICES}`;

// ===========================================================================
// Shared conventions handed to every build / address / resolve agent
// ===========================================================================
const CONV =
	`REPO ROOT: ${ROOT}\n` +
	`This is the monorepo ${REPO}; remote \`origin\` = git@github.com:${REPO}.git (USE THIS). ` +
	`BASE BRANCH FOR THIS PIPELINE: \`${BASE}\` — the UNIFIED integration branch (created by the pipeline's seed step from ${INBOUND} + ${WIRE}). Worktrees branch from origin/${BASE}; piece PRs TARGET ${BASE} (wave-1 landing pieces are the exception — their cards name their old base); the pipeline NEVER merges anything to ${MAIN} (the integration branch goes to ${MAIN} later as ONE giant HUMAN-merged PR opened by piece F1).\n` +
	`THE MAIN CHECKOUT AT ${ROOT} IS NOT YOURS: it may be on a different branch with uncommitted work. Use it ONLY for \`git -C "${ROOT}" fetch/worktree/branch\` plumbing; never switch its branch, never edit files in it.\n` +
	`RELEVANT SURFACES — OUTBOUND: apps/mta/src/smtp/{sender,connectionPool,dkim,tlsSecuredCapture,submissionServer,submissionSecurity}.ts; apps/api/convex/lib/sendProviders/smtp/index.ts (+ CONVENTIONS.md, lib/env.ts); apps/api/convex/mail/rfc822.ts (thin adapter over mail-message); apps/mail-sync/src/{send,tls}.ts. INBOUND: apps/mta/src/bounce/{server,parser,forwarder,fblProcessor,effects,inboundDkim,inboundDmarc,inboundSecurity,types}.ts + src/bounce/phases/, apps/mta/src/lib/dataStream.ts, apps/mail-sync/src/ingest.ts, packages/shared/src/{mailMime,address}.ts. ` +
	`THE FOUR PACKAGES: packages/smtp-listener, packages/mail-message (src/parse/ + src/compose/ after U0), packages/mail-auth (canon is the ONLY canonicalization in the repo), packages/smtp-client. The oracles nodemailer, mailparser, mailauth, smtp-server survive as devDependencies of differential/parity tests ONLY.\n\n` +
	`GOAL OF THIS PIPELINE: land the unified 2026-07-16 Own the Mail plan on ${BASE} — finish the engines, cut over all six call sites (mail-sync send + ingest, API relay, MTA pool + sender, submission 587/465, MX port 25), excise all four libraries — WITHOUT losing existing behavior (except the enumerated, signed-off improvements).\n\n` +
	BRIEF +
	`\n\n` +
	`WORKTREE DISCIPLINE (REQUIRED): do ALL file changes in a DEDICATED git worktree under ${SCRATCH} created from the piece's base branch. NEVER switch branches or edit files in the user's main checkout at ${ROOT} (a convex dev watcher may be running there and rewrites api.d.ts). Use \`git -C "$WT"\` and edit files under "$WT". Pieces run in PARALLEL — never touch another piece's worktree or branch. Always remove your worktree when done.\n\n` +
	`HARD RULES:\n` +
	`- VERIFICATION IS OFFLOADED TO GITHUB ACTIONS. Do NOT run \`bun run ci:verify\`, a full \`turbo lint/typecheck/test\`, a cold \`npx vitest\` over the whole repo, or \`bun install\` + build chains inside the fresh worktree (no node_modules / cold builds exceed the ~180s no-progress watchdog and kill you) — the ONLY exception is a piece whose card explicitly sanctions \`bun install\` for lockfile regeneration (run it with a generous timeout; bun streams progress). On push, GitHub Actions runs the full gate — that is the source of truth. Only INSTANT local checks are allowed: targeted \`grep\`/\`rg\`, reading files, a quick JSON/YAML parse, \`node -e\` one-liners. Give every Bash command a \`timeout\`.\n` +
	`- CI ENFORCES oxfmt FORMATTING. Before you push, format the files you changed: \`oxfmt --config "${ROOT}/oxfmtrc.json" --write <changed .ts/.js files>\` (run on the worktree copies; EXCLUDE any \`_generated/\` paths; NEVER run bare oxfmt without --config).\n` +
	`- ENV DISCIPLINE: new Convex-side vars only via apps/api/convex/lib/env.ts (lint:env blocks direct process.env); MTA-side vars via apps/mta/src/config.ts; add every new var to .env.example with a comment.\n` +
	`- Tests are vitest, never \`bun test\`. THE TEST GATE IS HARD: implement every test file named on your piece card — the reviewer rejects the PR otherwise. Let CI run them.\n` +
	`- SEMANTICS-PRESERVING IS DEFAULT (I2/W8): do NOT change behavior except the enumerated sanctioned improvements. Any such change MUST be pinned in a fixture and called out in the PR body — never silent. NO back-compat shims (I3): delete the old path in the SAME piece that replaces it.\n` +
	`- ONE CANON (U4): DKIM canonicalization exists ONLY in packages/mail-auth/src/canon.ts. If your piece needs canonicalization, import @owlat/mail-auth/canon — writing a second implementation is review-fatal.\n` +
	`- Do NOT weaken existing behavior: the bounce classifier, VERP/quota routing, FBL/DSN scrapers, DKIM rotation, TLS-RPT recording, MTA-STS behavior, the EmailErrorCode taxonomy, and every existing route survive. Keep changes strictly within the piece's file scope.\n` +
	`- Commits: small and ATOMIC (one logical change each — package code separate from tests, tests separate from docs), conventional messages (feat:/refactor:/fix:/test:/chore:/docs:). ABSOLUTELY NO AI/Claude attribution — no "Co-Authored-By: Claude", no "Generated with", nothing identifying the commit as AI-authored.\n` +
	`- STAY IN SCOPE: work ONLY on this one piece and its branch/worktree. Do NOT read this workflow script, do NOT touch other pieces' branches, do NOT start other pieces.\n` +
	`- KEEP MOMENTUM: ~180-second no-progress watchdog per step. Prefer ripgrep + targeted Reads (offset/limit) over reading whole large files; act incrementally with frequent tool calls. Some source files contain em-dash bytes that make grep treat them as binary — use \`grep -a\` if a text search unexpectedly finds nothing.\n` +
	`- STRICT TypeScript is the #1 CI failure cause — write type-correct code the FIRST time (strict + noUncheckedIndexedAccess + noPropertyAccessFromIndexSignature): (a) index-signature / dynamic-key access MUST use bracket notation and be narrowed; (b) any array/Map/object lookup can be \`undefined\` — guard it; (c) NO new \`any\`; (d) remove EVERY unused import/var/param; (e) exhaustive switch/discriminated unions need a default or never-check.\n`;

// ===========================================================================
// LOCAL PREFLIGHT — cheap, watchdog-SAFE checks that catch most CI failures
// WITHOUT a cold build.
// ===========================================================================
const PREFLIGHT =
	`LOCAL PREFLIGHT (run in the worktree BEFORE you push — these are fast and watchdog-safe; give each a \`timeout\`):\n` +
	`1. FORMAT: \`oxfmt --config "${ROOT}/oxfmtrc.json" --write <your changed .ts/.js files>\` (exclude any _generated/ paths). Instant.\n` +
	`2. LINT (catches unused vars/imports, no-explicit-any, and many correctness lints; needs NO types or build): \`oxlint --config "${ROOT}/oxlintrc.json" <changed dirs/files>\`. Read EVERY reported problem and fix it (hand-fix; \`--fix\` only for the safe auto-fixable ones). Re-run until zero errors on your files.\n` +
	`3. FAST REPO LINTS (pure file/grep checks, no build — run only if you touched files they cover): file-size ratchet \`bash "${ROOT}/scripts/check-file-size.sh"\`, branding \`bash "${ROOT}/scripts/check-branding.sh"\`, cross-package imports \`bash "${ROOT}/scripts/check-cross-package-imports.sh"\`. Fix anything they flag.\n` +
	`4. TYPES — reason, do not cold-build: you CANNOT run \`turbo typecheck\`/\`tsc\` here (needs a warm install + generated types; it will exceed the watchdog). Instead SELF-REVIEW every changed .ts against the STRICT TypeScript rules in HARD RULES above — read your own diff adversarially for undefined-index access, index-signature dot access, unused symbols, and new \`any\`. GitHub Actions runs the real typecheck.\n` +
	`Only push once preflight steps 1-3 are clean and you have self-reviewed types. This turns first-push-red into first-push-green and saves a whole CI+fix round.\n`;

// ===========================================================================
// PIECES — one atomic PR each. Wave-1 "landing" pieces adopt the five
// in-flight PRs on the OLD integration branches (their `base` says which);
// everything else targets the unified branch. A wave is an array of TRACKS;
// tracks run in parallel, pieces inside a track run SERIALLY.
// ===========================================================================
const PIECES = [
	// ---- Wave 1: land the five in-flight PRs into their OLD bases --------------
	// These PRs already exist and are believed complete (CI green/pending,
	// MERGEABLE). The builder's reuse check adopts them; the reviewer still runs
	// the full unified review; the author loop addresses every finding; then they
	// squash-merge into their OLD base so the seed merge carries them over.
	{
		id: 'L2',
		kind: 'feat',
		group: 'listener',
		dependsOn: [],
		base: INBOUND,
		branch: 'oti/l2-tls-auth-session',
		title: 'feat(smtp-listener): STARTTLS + AUTH + typed session context',
		spec:
			'ADOPT EXISTING PR #364 (head oti/l2-tls-auth-session, base ' + INBOUND + ') — it is believed complete; do NOT rebuild from scratch. Original card: ' +
			'ADD packages/smtp-listener/src/{tls.ts, auth.ts} + make session/transaction GENERIC type params in session.ts. ' +
			'STARTTLS upgrade with FULL STATE RESET (RFC 3207) + an implicit-TLS mode; the EXACT cipher policy of today\'s listeners (TLSv1.2 floor, AEAD-only ECDHE, honorCipherOrder, SNI). ' +
			'AUTH PLAIN/LOGIN with `requireTls`; a generic-failure rule (NO auth oracle — failures are byte-identical regardless of stage/cause). ' +
			'The old `SessionWithSpf` cast and the `sessionAuth` WeakMap DISAPPEAR — replaced by typed generic session context. ' +
			'ACCEPTANCE: the capability list flips correctly across the TLS upgrade; AUTH is refused pre-TLS, accepted post-upgrade; both STARTTLS and implicit-TLS work over real sockets.',
		tests:
			'NAMED TEST GATE: (a) tls.integration.test.ts (runtime-generated openssl certs); (b) starttlsReset.test.ts — a MAIL FROM issued BEFORE the upgrade must NOT survive it; (c) auth.test.ts — byte-identical failure replies across ALL stages (no oracle).',
	},
	{
		id: 'P2',
		kind: 'feat',
		group: 'parser',
		dependsOn: [],
		base: INBOUND,
		branch: 'oti/p2-body-charset',
		title: 'feat(mail-message): body assembly + per-part charset decoding',
		spec:
			'ADOPT EXISTING PR #362 (head oti/p2-body-charset, base ' + INBOUND + ') — it is believed complete; do NOT rebuild from scratch. Original card: ' +
			'ADD packages/mail-message/src/parse/{body.ts, charset.ts, attachments.ts}. ' +
			'Walk the MIME part tree; assemble `text` and `html` (preserve the load-bearing `false` sentinel); PER-PART charset decode via TextDecoder + a WHATWG alias table with a latin1 fallback; attachments in DOCUMENT ORDER with decoded filenames + Buffers + size + contentId; alternative/related traversal; broken-boundary tolerance (NEVER throw). ' +
			'The corrected charset decoding is a SANCTIONED improvement (I2) — pinned in charset.matrix.test.ts.',
		tests:
			'NAMED TEST GATE: (a) charset.matrix.test.ts (ISO-8859-1, windows-1252, Shift_JIS, GB2312/gb18030, EUC-KR, KOI8-R, BOM, declared-charset-lies, missing -> us-ascii); (b) attachmentOrder.test.ts — BYTE-IDENTICAL order vs the current mailMime.extractAttachments partIndex contract; (c) hostile.test.ts (1000-part bomb, 64-deep nesting, boundary-in-base64, headers-only, mixed CRLF/LF — ALL bounded, none throw).',
	},
	{
		id: 'A2',
		kind: 'feat',
		group: 'auth',
		dependsOn: [],
		base: INBOUND,
		branch: 'oti/a2-canon-dkim-verify',
		title: 'feat(mail-auth): canonicalization core + DKIM verifier (LONG POLE)',
		spec:
			'ADOPT EXISTING PR #363 (head oti/a2-canon-dkim-verify, base ' + INBOUND + ') — it is believed complete; do NOT rebuild from scratch. Original card: ' +
			'ADD packages/mail-auth/src/{canon.ts, dkim/verify.ts, dkim/keyRecord.ts}. ' +
			'canon.ts = RFC 6376 §3.4 relaxed + simple header/body canonicalization as a PUBLIC API (U4 — this becomes THE ONLY canonicalization in the repo; MD1\'s signer and a future ARC reuse it). ' +
			'dkim/verify.ts = the full verifier: rsa-sha256 + ed25519-sha256 (rsa-sha1 verified-but-policy-fail), multi-signature STRONGEST-WINS matching inboundDkim.pickVerdict, `l=` IGNORED -> verdict capped NEUTRAL, and it NEVER throws (internal error -> temperror). ' +
			'dkim/keyRecord.ts = hostile TXT parsing. REVIEWER: assume the author is wrong; try to construct a message that verifies differently under mailauth — a verifier bug AUTHENTICATES FORGED MAIL.',
		tests:
			'NAMED TEST GATE: (a) canon.vectors.test.ts (RFC vectors + vectors generated from mailauth for BYTE-IDENTITY); (b) dkimVerify.differential.test.ts — VERDICT EQUALITY vs mailauth (devDependency oracle); (c) dkimVerify.ltag.test.ts (append-attack -> capped neutral); (d) dkimAdversarial.test.ts (signature-header injection, CRLF smuggling, 10k-signature bomb — all bounded).',
	},
	{
		id: 'M2',
		kind: 'feat',
		group: 'composer',
		dependsOn: [],
		base: WIRE,
		branch: 'otw/m2-compose-message',
		title: 'feat(mail-message): composeMessage() — full nodemailer-composer parity, proven differentially',
		spec:
			'ADOPT EXISTING PR #361 (head otw/m2-compose-message, base ' + WIRE + ') — it is believed complete; do NOT rebuild from scratch. Original card: ' +
			'Generalize buildRfc822 into composeMessage(input) covering everything the MTA and API paths feed nodemailer today: from/replyTo/to/cc/bcc (display-name formatting), subject, html + text (stripHtml fallback), AMP as text/x-amp-html ordered plain -> amp -> html, attachments (Buffer, contentType, inline CID), arbitrary extra headers with injection stripping, explicit-or-generated Message-ID, returned envelope. Deterministic given seeded boundary/date inputs. ' +
			'THE DIFFERENTIAL HARNESS IS THE HEART: ~40 structured inputs composed by both nodemailer MailComposer and ours, both parsed with mailparser, asserting SEMANTIC equality (same part tree, decoded bodies, effective header values).',
		tests:
			'NAMED TEST GATE: (a) compose.differential.test.ts across the corpus; (b) a lint-style test asserting EVERY emitted line <= 998 octets over all fixture outputs; (c) a determinism test (byte-identical across two calls with identical seeds — the gate MD1 builds on).',
		focus:
			'Header folding at encoded-word boundaries; RFC 2047 75-octet cap including delimiters; an encoded-word must never split a multi-byte UTF-8 sequence.',
	},
	{
		id: 'S2',
		kind: 'feat',
		group: 'client',
		dependsOn: [],
		base: WIRE,
		branch: 'otw/s2-connection-engine',
		title: 'feat(smtp-client): connection engine — sockets, STARTTLS, and the secured flag',
		spec:
			'ADOPT EXISTING PR #360 (head otw/s2-connection-engine, base ' + WIRE + ') — it is believed complete; do NOT rebuild from scratch. Original card: ' +
			'packages/smtp-client/src/connection.ts — TCP connect with localAddress binding, implicit-TLS or cleartext-then-STARTTLS, greeting wait, EHLO (HELO fallback), STARTTLS honoring requireTls / rejectUnauthorized / minVersion (TLSv1.2 floor) / servername SNI, re-EHLO after upgrade, per-phase timeouts, first-class `secured` + negotiated-protocol metadata. TLS failures classified AT THE SOURCE into tlsCause from Node error codes — never from message strings.',
		tests:
			'NAMED TEST GATE: (a) connection.integration.test.ts against in-process smtp-server (implicit TLS, STARTTLS, STARTTLS-stripping + requireTls fails closed with tlsCause starttls-unavailable); (b) raw net-server edge tests (multiline greeting, greeting timeout, mid-handshake disconnect, self-signed / hostname-mismatch / expired certs each yield their EXACT tlsCause); (c) `secured` true iff the socket is TLS at EHLO-completion, asserted in both paths.',
	},

	// ---- Wave 2: U0 — the unification piece (after the SEED merge) --------------
	{
		id: 'U0',
		kind: 'refactor',
		group: 'unify',
		dependsOn: ['L2', 'P2', 'A2', 'M2', 'S2'],
		branch: 'otm/u0-unify-mail-message',
		title: 'refactor(mail-message): unify parse/ + compose/ subtrees; retire the ambiguous ./headers subpath; commit the unified pipeline',
		spec:
			'The SEED step already merged the two old integration branches into ' + BASE + ' with a MINIMAL mechanical resolution. This piece finishes the unification (U3/U5/U6): ' +
			'(1) RESTRUCTURE packages/mail-message: `git mv` the wire composer modules under src/compose/ — compose.ts, mime.ts, encoding.ts, messageId.ts, and headers.ts -> compose/headers.ts (the parse tree already lives at src/parse/). Update index.ts (the union stays collision-free), all internal imports, and the package.json exports map to DIRECTIONAL subpaths: ".", "./parse/headers", "./compose/headers" (plus compose/encoding/messageId as needed). RETIRE the ambiguous "./headers" subpath entirely; update its consumers (packages/shared/src/mailMime.ts imports the PARSE one; grep for every other subpath consumer, e.g. apps/api/convex/mail/rfc822.ts, and re-point them). ' +
			'(2) ADDRESS MODEL (U5): add addressRoundTrip.test.ts pinning parseAddressObject(encodeAddressHeader(x)).text round-trips over a shared fixture set; if the two formatters are trivially unifiable, unify them (parse-side types are the shared model) — otherwise leave both with the pin. ' +
			'(3) SCAFFOLD RECONCILIATION: one vitest.config.ts using the glob superset (both __tests__/ conventions); coverage thresholds per U6 — parse/auth-side gates stay at >=90 lines + branch coverage on the security modules; if the compose side is below the line, configure per-directory thresholds that keep the parse gates and note the R2 ratchet in the PR body (do NOT lower any existing gate). tsconfig include = union. package.json version 1.0.0, lint script covering src + __tests__. ' +
			'(4) CI MATRIX: verify .github/workflows/test.yml has ONE mail-message entry and includes smtp-listener, mail-auth, and smtp-client entries (the seed did the union — fix anything it missed). ' +
			'(5) PIPELINE HYGIENE: commit .claude/workflows/own-the-mail-prs.js (copy it READ-ONLY from ' + ROOT + '/.claude/workflows/own-the-mail-prs.js into the worktree) and DELETE .claude/workflows/nodemailer-removal-prs.js (and inbound-pipeline-prs.js if tracked) from the tree — one pipeline, one coordinator. ' +
			'DONE: all five package suites compile + pass in CI on the restructured tree; no source file imports "@owlat/mail-message/headers" (the retired subpath); check-cross-package-imports green.',
		tests:
			'NAMED TEST GATE: (a) ALL existing suites of all five packages green in CI after the restructure (moves must not break tests — that is the proof the union is sound); (b) NEW addressRoundTrip.test.ts (U5 pin); (c) a grep-style guard test (or CI grep captured in the PR body) proving zero imports of the retired ./headers subpath and zero remaining references to the old integration branch names in package code.',
	},

	// ---- Wave 3: finish the engines — 4 parallel --------------------------------
	{
		id: 'S3',
		kind: 'feat',
		group: 'client',
		dependsOn: ['U0'],
		branch: 'otm/s3-transaction-layer',
		title: 'feat(smtp-client): transaction layer — AUTH, envelope, DATA, verify(), sendMessage()',
		spec:
			'packages/smtp-client/src/transaction.ts + index.ts: AUTH PLAIN and LOGIN (ONLY after `secured` unless loopback — encode the mail-sync invariant in the client itself, refusing BEFORE credentials are serialized); MAIL FROM with SIZE when advertised; RCPT TO collecting PER-RECIPIENT verdicts (proceed if >=1 accepted, report the rest with their reply codes); DATA via the S1 dot-stuffer; QUIT/destroy teardown; a verify() (connect -> EHLO -> AUTH -> QUIT) for connection testing; and the one-shot sendMessage(opts) convenience wrapper. Every failure carries its phase — the property CW2\'s retry taxonomy is rebuilt on.',
		tests:
			'NAMED TEST GATE: packages/smtp-client/__tests__/transaction.integration.test.ts — (a) successful authed send against in-process smtp-server; message byte-identical after un-dot-stuffing; (b) partial RCPT acceptance (2 of 3) -> send proceeds, verdicts correct per recipient; (c) mid-DATA drop vs reject-at-MAIL distinguishable by phase (data/data-final = double-delivery-ambiguous; earlier phases safely retryable); (d) AUTH refused on an unsecured non-loopback connection BY THE CLIENT, before credentials are serialized.',
	},
	{
		id: 'L3',
		kind: 'test',
		group: 'listener',
		dependsOn: ['U0'],
		branch: 'otm/l3-hostile-parity',
		title: 'test(smtp-listener): hostile-client suite + smtp-server parity harness',
		spec:
			'ADD packages/smtp-listener/src/__tests__/{hostile.integration.test.ts, parity.test.ts}. NO new product code — the adversarial + drop-in-proof layer. ' +
			'HOSTILE clients: slowloris on every phase, oversized line, NUL in commands, early disconnect at each state, TLS-handshake abandonment, connection flood vs maxClients, pipelining desync — each asserted BOUNDED via budget counters and the correct timeout firing. ' +
			'PARITY: scripted SMTP conversations run against BOTH a real `smtp-server` (devDependency oracle) AND ours, asserting reply-sequence equality across greeting, EHLO caps, SPF-reject, VERP-accept, quota/oversize 552, the auth chain, and From-forgery 553. Divergences (the sanctioned enhanced-code improvements) ENUMERATED in a fixture, not discovered live. ' +
			'UNIFIED-REPO SYNERGY: drive the listener with our own packages/smtp-client where convenient (both stacks in one repo now) — smtp-server stays the parity ORACLE.',
		tests:
			'NAMED TEST GATE: the suite IS the deliverable — (a) hostile.integration.test.ts: every hostile case bounded (budget counter / right timeout asserted); (b) parity.test.ts: the parity table matches smtp-server modulo the documented, fixture-enumerated enhanced-code improvements.',
	},
	{
		id: 'P3',
		kind: 'feat',
		group: 'parser',
		dependsOn: ['U0'],
		branch: 'otm/p3-parsemessage-differential',
		title: 'feat(mail-message): parseMessage() facade + differential harness',
		spec:
			'ADD packages/mail-message/src/parse/index.ts (facade) + __tests__/{differential.test.ts, fuzz.test.ts, composeParse.roundtrip.test.ts}. ' +
			'`parseMessage(raw): ParsedMessage` assembling the FULL consumed-field contract: subject, messageId/inReplyTo (angle brackets INCLUDED — consumers strip), references (string | string[] dual shape), date (invalid -> undefined, never Invalid Date), structured headers Map with {value, params} content-type, address objects with `.text`, text, html | false sentinel, attachments in document order (partIndex contract). ' +
			'DEMOTE mailparser to a devDependency of THIS package (the differential oracle, not a runtime dep). ' +
			'ACCEPTANCE: differential green; the bounce pipeline\'s partial-`ParsedMail` mocks typecheck against `ParsedMessage` (drop-in proof); fuzz clean.',
		tests:
			'NAMED TEST GATE: (a) differential.test.ts — mailparser vs ours over the MTA/mail-sync inline fixtures + the P2 hostile corpus, EQUALITY OF EVERY CONSUMED FIELD (divergences = 0); (b) the typecheck proof for the bounce pipeline mocks; (c) fuzz.test.ts (10k mutations parse without throwing, within limits); (d) NEW UNIFIED-ONLY composeParse.roundtrip.test.ts — parseMessage(composeMessage(x)) over the M2 corpus asserts the consumed-field contract (our composer x our parser).',
	},
	{
		id: 'MD1',
		kind: 'feat',
		group: 'composer',
		dependsOn: ['U0'],
		branch: 'otm/md1-signer-shared-canon',
		title: 'feat(mail-message): DKIM signMessage(raw, key) over the SHARED canon (merged old M3 + A3)',
		spec:
			'THE DEDUPLICATION PIECE — old wire-M3 (port the signer) and old inbound-A3 (repoint it at shared canon) collapse into one: the signer is built on the shared canon FROM THE START, so mailauth\'s internals are never ported. ' +
			'(1) In packages/mail-auth: add a PURE "./canon" subpath export (package.json exports map) that transitively imports NO dns/Redis/node-only modules — Convex-\'use node\'-safe by construction; add a guard test that importing it pulls in no network module. ' +
			'(2) Port the MTA\'s hardened signer (apps/mta/src/smtp/dkim.ts — oversigned From/Subject/To, t= timestamp, relaxed/relaxed, extended header field list) to packages/mail-message/src/compose/dkim.ts: signMessage(raw: Buffer, key) -> Buffer PREPENDING the DKIM-Signature to composeMessage output. ALL canonicalization comes from @owlat/mail-auth/canon (U4) — writing any canonicalization logic in this package is review-fatal. mail-message gains the workspace dep on @owlat/mail-auth (subpath only). ' +
			'(3) DELETE apps/mta/src/types/mailauth-internals.d.ts. apps/mta/src/smtp/dkim.ts itself stays UNTOUCHED until CW4 cuts it over. ' +
			'DONE: `grep -rn "mailauth/lib" apps packages` returns TEST files only; the internals .d.ts is gone.',
		tests:
			'NAMED TEST GATE: (a) packages/mail-message/__tests__/dkim.test.ts — every corpus signature verifies with mailauth (independent oracle) AND with our own verifyDkim from mail-auth (the in-repo THREE-WAY agreement only the unified repo can have); (b) oversigning + t= matches the current signer BIT-FOR-BIT on the ported dkimSign e2e fixtures; (c) signature survives compose -> sign -> parse-with-mailparser -> reserialize (fold-stable); (d) the canon-subpath purity guard test.',
	},

	// ---- Wave 4: safety net + first cutovers — 4 parallel, disjoint apps --------
	{
		id: 'C0',
		kind: 'feat',
		group: 'cutover',
		dependsOn: ['P3', 'A2'],
		branch: 'otm/c0-shadow-replay-harness',
		title: 'feat(mta): shadow-replay harness over stored inbound mail + CI corpus slice',
		spec:
			'ADD apps/mta/src/tools/inboundReplay.ts + __tests__/replay.corpus.test.ts + a CHECKED-IN, non-sensitive corpus slice. ' +
			'The harness runs each raw `message/rfc822` blob through BOTH stacks (mailparser+mailauth vs parseMessage+mail-auth), does a FIELD-LEVEL diff of the routing/delivery drivers (parsed fields + DKIM/DMARC/SPF verdicts), and saves any divergent message to a regression corpus. It NEVER logs decoded bodies (I7). ' +
			'The harness accepts a corpus DIRECTORY so an operator can point it at sampled+scrubbed real stored mail from a dev deployment (that run is an OPERATIONAL step a human does pre-cutover); the CI test runs over the checked-in slice only. ' +
			'DONE: harness reusable; CI slice green; real inputs feed back into the P3 & A2 differential suites.',
		tests:
			'NAMED TEST GATE: NEW replay.corpus.test.ts — old-vs-new over the checked-in slice, categorized divergence report, ZERO unsanctioned divergence on routing/delivery drivers (allowed: the enumerated l=/charset/enhanced-code improvements). Assert the harness never writes decoded body text to logs.',
	},
	{
		id: 'CW1',
		kind: 'refactor',
		group: 'mailsync',
		dependsOn: ['S3'],
		branch: 'otm/cw1-mailsync-send',
		title: 'refactor(mail-sync): cut SEND over to smtp-client (pilot: protocol only, no composer)',
		spec:
			'The lowest-risk cutover proves the client first: apps/mail-sync/src/send.ts sendViaExternal already ships raw .eml bytes, so this swaps ONLY the transport (custom envelope, Bcc via RCPT set preserved). apps/mail-sync/src/tls.ts smtpTlsOptions maps onto client options — loopback-only plaintext exception (Proton Bridge) preserved EXACTLY; requireTls + TLSv1.2 floor otherwise. Per-recipient RCPT verdicts replace the info.rejected inference. testSmtp uses the client\'s verify(). IMAP side untouched; ingest.ts untouched (that is CI1). nodemailer removed from apps/mail-sync/package.json in this PR (regenerate bun.lock — sanctioned); the old path DELETED, no shim.',
		tests:
			'NAMED TEST GATE: (a) existing apps/mail-sync send.test.ts, tls.test.ts, connection.tls.test.ts pass, rewritten ONLY where they asserted nodemailer internals (reviewer checks assertions were not gutted); (b) Bcc semantics: the RCPT set is exactly params.recipients, independent of visible headers; (c) grep proves nodemailer gone from apps/mail-sync package.json and imports.',
	},
	{
		id: 'CW2',
		kind: 'refactor',
		group: 'api',
		dependsOn: ['M2', 'S3'],
		branch: 'otm/cw2-api-relay',
		title: 'refactor(api): cut over the relay adapter — composer + client + error taxonomy on structured phases',
		spec:
			'apps/api/convex/lib/sendProviders/smtp/index.ts: sendEmail becomes composeMessage -> sendMessage with the cached-client-config pattern intact (lazy from SMTP_RELAY_* via lib/env.ts). THE CRITICAL WORK is rebuilding classifySmtpError on structured input: phase in {connect, greeting, ehlo, starttls, auth} -> retryable SERVER_ERROR/AUTH_FAILED (nothing reached the wire); phase in {data, data-final} with no reply -> AMBIGUOUS_TIMEOUT (the 250 may be lost — NEVER auto-retry); a numeric reply code stays authoritative via the existing smtpReplyCodeToErrorCode table, which survives UNCHANGED. The outer withTimeout ambiguity rule and SMTP_CONNECTION_TIMEOUT_MS pre-acceptance bound keep exact semantics. String-matching helpers (isTimeoutError, isConnectionLoss) DELETED, not adapted. Runs under \'use node\'; bun run lint:env clean; nodemailer removed from apps/api/package.json (regenerate bun.lock — sanctioned). Read apps/api/convex/CONVENTIONS.md before touching convex files.',
		tests:
			'NAMED TEST GATE: (a) categorizeError.test.ts — EVERY case in the existing table-driven tests has a successor asserting the SAME EmailErrorCode from structured input; the double-delivery decision table provably unchanged case-by-case (reviewer diffs old vs new); (b) requireTLS preserved fail-closed; (c) grep proves isTimeoutError/isConnectionLoss and all nodemailer imports gone from apps/api.',
		focus:
			'Any path where a retryable classification could now reach a post-DATA failure = double-delivery bug. Treat as blocking.',
	},
	{
		id: 'CW3',
		kind: 'refactor',
		group: 'mta-out',
		dependsOn: ['S3', 'MD1'],
		branch: 'otm/cw3-mta-pool',
		title: 'refactor(mta): connection pool on smtp-client (keying, Redis cap, gauges preserved; DKIM plugin removed)',
		spec:
			'apps/mta/src/smtp/connectionPool.ts keeps its EXACT shape — key {mx, bindIp, dkimDomain, tlsProfile}, per-host LRU eviction, idle/age eviction, Redis global slot INCR/DECR with fail-open, Prometheus gauge — but entries hold smtp-client configs instead of nodemailer transports (one-connection-per-send preserved per W3; live-socket reuse is X1, NOT this piece). The use(\'stream\') DKIM plugin wiring is DELETED: signing moves to compose time (CW4), so the pool stops knowing about message transformation entirely. dkimDomain stays in the key purely as a partitioning dimension.',
		tests:
			'NAMED TEST GATE: (a) connectionPool.test.ts — all pool tests pass with test doubles targeting the new client interface; the TLS-profile keying test (enforce vs opportunistic NEVER share an entry) preserved verbatim; (b) global-cap reserve/release accounting identical: reuse takes no slot, every teardown path releases.',
	},

	// ---- Wave 5: heavy cutovers — 3 parallel, disjoint file sets -----------------
	{
		id: 'CW4',
		kind: 'refactor',
		group: 'mta-out',
		dependsOn: ['CW3', 'M2', 'MD1'],
		branch: 'otm/cw4-mta-sender',
		title: 'refactor(mta): sender — compose-once + sign-once, structured TLS results, delete tlsSecuredCapture',
		spec:
			'THE OUTBOUND CENTERPIECE. apps/mta/src/smtp/sender.ts sendToMx composes ONCE per job — composeMessage (html/text/AMP/attachments/headers, From-aligned Message-ID, VERP envelope) then signMessage — and retries the SAME signed bytes across MX hosts and TLS profiles (byte-identical retries: a strict improvement over per-attempt recomposition). attemptSend reads client.secured directly for TLS-RPT result recording — apps/mta/src/smtp/tlsSecuredCapture.ts is DELETED, with its logger threading through the pool. classifyTlsFailure becomes a thin map SmtpError.tlsCause -> TlsResultType; the string-matching table goes. apps/mta/src/smtp/dkim.ts slims to key management (signing lives in mail-message now). The MTA\'s duplicated buildMessageId/stripHtml migrate to mail-message imports. Everything RFC-semantic preserved UNCHANGED: MTA-STS enforce MX filtering + testing-mode probe-then-opportunistic-retry, stsAttributedResultType escalation, 4xx/5xx/5.2.2 bounce classification, per-IP EHLO names. Remove deleted files from coverage config if referenced.',
		tests:
			'NAMED TEST GATE: (a) all touched apps/mta/src/smtp/__tests__ suites green; the STARTTLS-stripping, cert-mismatch, and plaintext-delivery TLS-RPT scenarios assert IDENTICAL recorded result types; (b) NEW: composed+signed bytes byte-identical across MX retries of one job; (c) DKIM on the wire verifies with mailauth in the e2e signing test; (d) grep -ri nodemailer apps/mta/src -> only historical comments, no imports.',
		focus:
			'TLS-RPT truthfulness: cleartext success must still record starttls-not-supported (not success); enforce-mode cert failures must still reach sts-webpki-invalid. These feed reports we send to other mail operators.',
	},
	{
		id: 'CI1',
		kind: 'feat',
		group: 'mailsync',
		dependsOn: ['C0', 'CW1'],
		branch: 'otm/ci1-mailsync-ingest',
		title: 'feat(mail-sync): cut INGEST over to parseMessage',
		spec:
			'apps/mail-sync/src/ingest.ts + package.json: swap `simpleParser` -> `parseMessage`, PRESERVING the Convex wire shape EXACTLY (1 MB body cap, synthetic Message-ID fallback, partIndex ordering, address `.text`). REMOVE `mailparser` from apps/mail-sync/package.json (I3 — no shim, no dual path; regenerate bun.lock — sanctioned). ' +
			'GATED on a clean replay report over IMAP-shaped mail (C0). Same app as CW1 but different files — CW1 landed the wave before, so build on its state.',
		tests:
			'NAMED TEST GATE: (a) existing mail-sync ingest suites pass — rewritten ONLY where they asserted mailparser internals; (b) EXTEND the replay assertion: ZERO routing-field divergence on the IMAP-shaped corpus slice; (c) a non-UTF-8 real-shaped message ingests with the correct decoded body.',
	},
	{
		id: 'CI3',
		kind: 'feat',
		group: 'mta-in',
		dependsOn: ['C0', 'A2'],
		branch: 'otm/ci3-auth-verdicts',
		title: 'feat(mta): cut auth verdicts over (SPF/DMARC wiring + DKIM verify)',
		spec:
			'apps/mta/src/bounce/{server.ts, inboundDkim.ts, inboundDmarc.ts, inboundSecurity.ts}: point the inbound path at `@owlat/mail-auth` — SPF/DMARC resolve through the cached resolver; inbound DKIM runs the NEW verifier instead of mailauth dkimVerify. The normalized verdict shape into the pipeline is UNCHANGED. Security-sensitive: gated on a clean replay verdict report. ' +
			'DONE: no auth logic left inline (I3); verdicts provably preserved EXCEPT the intended `l=` tightening, whose every affected message is enumerated and individually signed off.',
		tests:
			'NAMED TEST GATE: (a) existing inboundAuth.dkim / inboundAuth.dmarc / server suites stay green; (b) REPLAY VERDICT DIVERGENCE = 0 except the `l=` tightening, each affected message enumerated in a fixture; (c) a DNS-cache lookup-reduction assertion (cached run makes fewer resolver calls than a cold run).',
	},

	// ---- Wave 6: submission + regression net — 2 parallel ------------------------
	{
		id: 'CI2',
		kind: 'feat',
		group: 'mta-in',
		dependsOn: ['CI1', 'L3', 'CW4'],
		branch: 'otm/ci2-submission-listener',
		title: 'feat(mta): cut the submission listener (587 / 465) onto smtp-listener',
		spec:
			'apps/mta/src/smtp/submissionServer.ts + submissionSecurity.ts (hook wiring only): rebuild BOTH factories on packages/smtp-listener — STARTTLS 587 + implicit-TLS 465, the auth chain (master key / per-org credential / Postbox app password) as a TYPED auth handler, the From-forgery 553 guard, per-recipient job fan-out, `parseMessage` for the body, and the AMP `text/x-amp-html` recovery. The `sessionAuth` WeakMap becomes typed session ctx; the byte budget is now the listener\'s (I3). ' +
			'Scheduled AFTER CW4 so the two apps/mta/src/smtp rewrites never collide. ' +
			'DONE: authenticated submission is behaviorally IDENTICAL on both ports.',
		tests:
			'NAMED TEST GATE: (a) existing submissionServer.test.ts + bannerEhlo.integration.test.ts pass — rewritten ONLY for internals; (b) auth-chain parity across ALL THREE credential types (failures throttled + reply-identical; 553 5.7.1 on From-forgery); (c) AMP recovery + per-recipient fan-out preserved.',
	},
	{
		id: 'R2',
		kind: 'test',
		group: 'regression',
		dependsOn: ['CW4'],
		branch: 'otm/r2-quirks-goldens',
		title: 'test: long-tail quirk suite + golden .eml corpus with mailauth re-verification in CI',
		spec:
			'The insurance policy. (1) packages/smtp-client/__tests__/quirks.integration.test.ts — raw-socket fake servers reproducing real-world misbehavior: reply lines split across TCP packets, multiline replies with inconsistent codes, greeting in two writes, early 421 mid-transaction, 4xx to STARTTLS, timeout-then-banner, 8-bit garbage in replies, CRLF-less final responses. Each quirk NAMED with a provenance comment. (2) GOLDEN CORPUS: checked-in .eml outputs at packages/mail-message/__tests__/golden/*.eml for the M2 fixture inputs, diffed BYTE-FOR-BYTE in CI, every golden\'s DKIM signature re-verified with mailauth on every run. Regeneration only via a dedicated `bun run goldens:update` script. (3) UNIFIED SYNERGY: the goldens double as parse fixtures — feed them through the P3 differential suite. (4) COVERAGE RATCHET: raise any per-directory thresholds U0 had to lower back to the U6 bar (>=90 package-wide).',
		tests:
			'NAMED TEST GATE: (a) quirks.integration.test.ts with every listed quirk, named + provenance; (b) golden corpus + byte-diff test + mailauth DKIM re-verification; (c) goldens:update script exists and is documented; (d) goldens wired into the P3 differential suite; (e) the coverage ratchet applied.',
	},

	// ---- Wave 7: the open internet — port 25, highest exposure -------------------
	{
		id: 'CI4',
		kind: 'feat',
		group: 'mta-in',
		dependsOn: ['CI2', 'CI3'],
		branch: 'otm/ci4-mx-listener-parsedmail',
		title: 'feat(mta): cut the MX listener (port 25) + ParsedMail -> ParsedMessage migration',
		spec:
			'apps/mta/src/bounce/server.ts + a type migration across forwarder.ts, parser.ts, fblProcessor.ts, effects.ts, phases/resolveRoute.ts, types.ts: rebuild the MX listener on packages/smtp-listener — SPF-gated onMailFrom (typed txn ctx replaces SessionWithSpf), VERP/quota/route onRcptTo (structured 552/550), tarpit, onMessage -> the existing pipeline now consuming `ParsedMessage`. Migrate the `ParsedMail` type-only imports. The DSN/ARF scrapers keep their contract. At-least-once ACK-on-error becomes the EXPLICIT `AckAndSwallowErrors` decision. Delete apps/mta/src/lib/dataStream.ts if this piece orphans it. ' +
			'DONE: port-25 fully on the new stack, replay-clean end-to-end, pre-cutover Prometheus baseline noted in the PR body.',
		tests:
			'NAMED TEST GATE: (a) EVERY bounce/inbound suite green (pipeline, parser, classifier, outcome, effects, fblProcessor, verp, phases, server); (b) REPLAY CLEAN end-to-end over the corpus slice (identical mailbox-delivery / bounce-class / FBL-dedup / accept-forward outcomes); (c) the L3 hostile suite runs against the real production listener config; (d) VERP HMAC attribution + ARF dedup + complaint-rate alerting assertions unchanged.',
	},

	// ---- Wave 8: the combined excision --------------------------------------------
	{
		id: 'R1',
		kind: 'chore',
		group: 'removal',
		dependsOn: ['CW1', 'CW2', 'CW4', 'CI1', 'CI2', 'CI3', 'CI4'],
		branch: 'otm/r1-excise-all-libraries',
		title: 'chore: excise ALL FOUR mail libraries — nodemailer removed; smtp-server/mailparser/mailauth -> devDependencies',
		spec:
			'The combined excision (old wire-R1 + old inbound-R1 — same files, one piece): ' +
			'(1) Remove nodemailer + @types/nodemailer from the last package.json (apps/mta) — it survives ONLY as packages/mail-message\'s differential-test devDependency. ' +
			'(2) Remove smtp-server, mailparser, mailauth from apps/mta RUNTIME deps (each survives as a devDependency of its differential/parity suite: smtp-server in mta tests + smtp-listener parity; mailauth in mta + mail-auth; mailparser in mail-message). ' +
			'(3) Confirm apps/mta/src/types/mailauth-internals.d.ts is deleted (MD1 did it). Regenerate bun.lock (sanctioned). Sweep ALL stale comment references (~70 across both plans — grep -ri each library name to find them: convexRuntimeEnv.ts, externalAccountsActions.ts, mtaSts.ts, types.ts, dataStream docblock, SPF docblock, docs). knip/lint:deadcode clean. ' +
			'DONE: the production mail path — both directions — has ZERO third-party mail libraries.',
		tests:
			'NAMED TEST GATE: (a) `grep -ri nodemailer apps/` -> ZERO hits AND `grep -rn "smtp-server\\|mailparser\\|mailauth" apps/` -> production zero (tests/devDeps only) — capture BOTH greps in the PR body; (b) CI green (its frozen-lockfile install is the fresh-install proof); (c) the one-week post-merge watch plan documented with pre-cutover baselines (outbound soft-bounce + connection-failure rates; inbound accept/bounce/deferral + DKIM/DMARC pass rates).',
	},

	// ---- Wave 9: capability follow-ups (serial — all extend smtp-client; optional) --
	{
		id: 'X1',
		kind: 'feat',
		optional: true,
		group: 'capability',
		dependsOn: ['R1', 'R2'],
		branch: 'otm/x1-socket-reuse',
		title: 'feat: true socket reuse — RSET-based multi-message connections in the MTA pool',
		spec:
			'Pool entries hold LIVE connected clients; consecutive jobs to the same {mx, bindIp, dkimDomain, tlsProfile} reuse the socket via RSET between transactions (packages/smtp-client/src/transaction.ts grows RSET-boundary multi-transaction support; apps/mta/src/smtp/connectionPool.ts + sender.ts adopt it). Guardrails: max-messages-per-connection cap (~100 default), max lifetime honoring today\'s maxAgeMs, unhealthy-connection detection (ANY transport error tears down the entry — never retry a poisoned socket), Redis global cap now counts live sockets. Prometheus gains reused_total.',
		tests:
			'NAMED TEST GATE: (a) N sequential sends to one fake MX use ONE connection with RSET boundaries; message N+cap triggers clean QUIT + reconnect; (b) 421 or socket death mid-stream evicts the entry, releases the Redis slot, in-flight job retries on a fresh connection exactly once; (c) secured + TLS-RPT remain per-CONNECTION, correctly attributed to every message on it; (d) reused_total counter test.',
		focus:
			'State leakage between transactions on a reused socket (leftover replies, half-read multiline responses) — the classic reuse bug class.',
	},
	{
		id: 'X2',
		kind: 'feat',
		optional: true,
		group: 'capability',
		dependsOn: ['X1'],
		branch: 'otm/x2-pipelining',
		title: 'feat(smtp-client): PIPELINING (RFC 2920) — batch envelope commands when advertised',
		spec:
			'When EHLO advertises PIPELINING, send MAIL FROM + all RCPT TOs + DATA in one write and read replies as a batch. STRICTLY capability-gated: non-advertising servers keep the v1 sequential path unchanged. Per-recipient verdicts and the phase-based taxonomy INDISTINGUISHABLE from sequential mode — pipelining changes timing, never semantics.',
		tests:
			'NAMED TEST GATE: pipelining.integration.test.ts — (a) batched replies matched to commands incl. mixed accept/reject RCPT sets and a rejected MAIL FROM aborting the batch; (b) quirk tests (advertises PIPELINING but replies one-packet-per-line; replies split mid-batch); (c) CW2\'s classification tests pass identically with pipelining forced on and off.',
	},
	{
		id: 'X3',
		kind: 'feat',
		optional: true,
		group: 'capability',
		dependsOn: ['X2'],
		branch: 'otm/x3-smtputf8',
		title: 'feat: SMTPUTF8 / EAI (RFC 6531-6532) — internationalized addresses end-to-end, fail-closed downgrade',
		spec:
			'UTF-8 localparts through composer and client. Composer: UTF-8 headers natively when flagged EAI (encoded-words remain for non-EAI); domains still IDN-normalized. Client: request SMTPUTF8 on MAIL FROM when advertised; when NOT advertised, FAIL CLOSED with a precise user-visible error (no punycode exists for localparts — never silently mangle). Contact import/validation surfaces stop rejecting these addresses.',
		tests:
			'NAMED TEST GATE: (a) EAI compose -> mailparser parse round trip byte-exact for addresses/headers; DKIM verifies with mailauth; (b) non-advertising server fails at phase mail with a distinct EmailErrorCode, recorded as hard non-retryable; (c) ASCII-only mail byte-identical to pre-X3 — the R2 golden corpus passes UNCHANGED.',
	},
	{
		id: 'X4',
		kind: 'feat',
		optional: true,
		group: 'capability',
		dependsOn: ['X3'],
		branch: 'otm/x4-xoauth2',
		title: 'feat: AUTH XOAUTH2 — token-based auth for external Gmail / Microsoft accounts',
		spec:
			'SASL XOAUTH2 (user=…\\x01auth=Bearer …\\x01\\x01) as a third auth option in packages/smtp-client; the 334 challenge-response error decoded into a structured auth-phase failure (expired token vs bad credentials DISTINGUISHABLE — refresh vs reconnect-account). apps/mail-sync/src/send.ts grows the option plumbing; token acquisition/refresh is the external-accounts OAuth feature\'s scope, NOT this piece. Like all AUTH: refused on unsecured non-loopback before anything serializes.',
		tests:
			'NAMED TEST GATE: (a) fake server validating the EXACT XOAUTH2 initial-response encoding; success + both failure shapes; (b) expired-token 334 -> distinct retryable-after-refresh error; malformed credentials -> terminal AUTH_FAILED; (c) PLAIN/LOGIN paths byte-identical to pre-X4 (existing transaction tests unchanged).',
	},

	// ---- Wave 10: the one PR (base: main; HUMAN-merged) ---------------------------
	{
		id: 'F1',
		kind: 'chore',
		group: 'ship',
		dependsOn: ['R1', 'R2'],
		wave: 10,
		base: MAIN,
		humanMerge: true,
		branch: BASE, // head of the F1 PR is the integration branch itself
		title: 'Own the Mail — in-house SMTP client + listener, MIME composer + parser, mail-auth; all four libraries removed (human-merged)',
		spec:
			'NO new code. Final main-sync + the narrative PR body + whole-tree verification on the aggregate draft PR the SEED opened (main <- ' + BASE + '), then STOP for a human squash-merge. ' +
			'STEPS: (1) merge origin/main INTO the integration branch one last time in a scratch worktree (trunk wins) and push; (2) AUDIT: every non-optional piece is merged (wave-1 five via the seed merge, then U0, S3, L3, P3, MD1, C0, CW1, CW2, CW3, CW4, CI1, CI2, CI3, CI4, R1, R2 — check `gh pr list --repo REPO --base ' + BASE + ' --state merged` plus the two old branches\' merged PR lists), NO TODO(own-the-mail|own-the-wire|own-the-inbound) markers, and BOTH removal greps clean; note any DROPPED optional X capability honestly; (3) mark the aggregate PR READY (remove draft) and rewrite its body: the unified-plan framing (one stack, both directions; the two source plans and why they merged), a PER-PIECE TABLE linking every constituent PR + review across all three branches, the enumerated sanctioned improvements, payoff table (deleted workarounds both directions), risk checklist, and the one-week post-merge watch plan (outbound soft-bounce + connection-failure Prometheus rates + reused_total if X1 landed; inbound accept/bounce/deferral + DKIM/DMARC pass rates vs baseline). End with: "HUMAN MERGE ONLY — this is the whole migration as one revertable squash-merge; Marcel reviews and merges." ' +
			'This piece DOES NOT MERGE — it stops at approved + green for Marcel.',
		tests:
			'GATE: full ci:verify GREEN on the PR head AFTER the final sync — every package suite + replay + differential + golden-corpus jobs on the MERGED TREE. `grep -ri nodemailer apps/` -> zero AND `grep -rn "smtp-server\\|mailparser\\|mailauth" apps/` -> production zero on the head.',
	},
];

// Explicit wave/track layout. A wave is an array of TRACKS; tracks run in
// parallel, pieces inside a track run SERIALLY. The SEED step runs between
// wave 1 (landing) and wave 2 (U0). R1 and F1 are separate waves so the
// post-R1 main-sync runs before F1 finalizes the aggregate PR. Wave 9 is the
// all-optional X track — its failure never blocks F1.
const WAVES = [
	[['L2'], ['P2'], ['A2'], ['M2'], ['S2']], // wave 1 · land the five in-flight PRs (old bases)
	[['U0']], // wave 2 · unification piece (SEED runs just before)
	[['S3'], ['L3'], ['P3'], ['MD1']], // wave 3 · finish the engines
	[['C0'], ['CW1'], ['CW2'], ['CW3']], // wave 4 · safety net + first cutovers
	[['CW4'], ['CI1'], ['CI3']], // wave 5 · heavy cutovers (disjoint file sets)
	[['CI2'], ['R2']], // wave 6 · submission + regression net
	[['CI4']], // wave 7 · MX listener (highest exposure)
	[['R1']], // wave 8 · combined excision
	[['X1', 'X2', 'X3', 'X4']], // wave 9 · optional capabilities (serial track)
	[['F1']], // wave 10 · the one PR (human-merged)
];
const LANDING_WAVE_INDEX = 0; // wave 1 lands into the OLD branches; SEED runs after it

// ===========================================================================
// Structured-output schemas
// ===========================================================================
const BUILD_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['opened', 'reused', 'prNumber', 'prUrl', 'branch', 'commits', 'summary'],
	properties: {
		opened: { type: 'boolean' },
		reused: { type: 'boolean' },
		alreadyLanded: { type: 'boolean' },
		prNumber: { type: 'integer' },
		prUrl: { type: 'string' },
		branch: { type: 'string' },
		commits: { type: 'array', items: { type: 'string' } },
		testsAdded: { type: 'array', items: { type: 'string' } },
		blockReason: { type: 'string' },
		summary: { type: 'string' },
	},
};
const CI_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['state', 'failing', 'summary'],
	properties: {
		state: { type: 'string', enum: ['pass', 'fail', 'pending', 'unknown'] },
		failing: { type: 'array', items: { type: 'string' } },
		summary: { type: 'string' },
	},
};
const PR_STATE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['lastIsUnaddressedReview', 'summary'],
	properties: {
		lastIsUnaddressedReview: { type: 'boolean' },
		openConcerns: { type: 'array', items: { type: 'string' } },
		summary: { type: 'string' },
	},
};
const REVIEW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['verdict', 'commentPosted', 'blockingFindings', 'improvements', 'summary'],
	properties: {
		verdict: { type: 'string', enum: ['approve', 'request_changes'] },
		commentPosted: { type: 'boolean' },
		blockingFindings: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['file', 'issue'],
				properties: {
					file: { type: 'string' },
					line: { type: 'integer' },
					issue: { type: 'string' },
				},
			},
		},
		improvements: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['file', 'issue'],
				properties: {
					file: { type: 'string' },
					line: { type: 'integer' },
					issue: { type: 'string' },
				},
			},
		},
		summary: { type: 'string' },
	},
};
const ADDRESS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['commits', 'pushed', 'resolved', 'unresolved', 'summary'],
	properties: {
		commits: { type: 'array', items: { type: 'string' } },
		pushed: { type: 'boolean' },
		resolved: { type: 'array', items: { type: 'string' } },
		unresolved: { type: 'array', items: { type: 'string' } },
		summary: { type: 'string' },
	},
};
const MERGE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['merged', 'prUrl', 'outstanding', 'summary'],
	properties: {
		merged: { type: 'boolean' },
		mergeCommit: { type: 'string' },
		prUrl: { type: 'string' },
		conflict: { type: 'boolean' },
		conflictFiles: { type: 'array', items: { type: 'string' } },
		outstanding: { type: 'array', items: { type: 'string' } },
		summary: { type: 'string' },
	},
};
const RESOLVE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['resolved', 'pushed', 'files', 'summary'],
	properties: {
		resolved: { type: 'boolean' },
		pushed: { type: 'boolean' },
		files: { type: 'array', items: { type: 'string' } },
		blockReason: { type: 'string' },
		summary: { type: 'string' },
	},
};
const SYNC_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['merged', 'pushed', 'conflicts', 'summary'],
	properties: {
		merged: { type: 'boolean' },
		pushed: { type: 'boolean' },
		conflicts: { type: 'array', items: { type: 'string' } },
		blockReason: { type: 'string' },
		summary: { type: 'string' },
	},
};
const SEED_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['created', 'pushed', 'aggregatePrNumber', 'closedOldPrs', 'summary'],
	properties: {
		created: { type: 'boolean' },
		reused: { type: 'boolean' },
		pushed: { type: 'boolean' },
		aggregatePrNumber: { type: 'integer' },
		aggregatePrUrl: { type: 'string' },
		closedOldPrs: { type: 'boolean' },
		conflictsResolved: { type: 'array', items: { type: 'string' } },
		blockReason: { type: 'string' },
		summary: { type: 'string' },
	},
};

// ===========================================================================
// Prompt builders
// ===========================================================================
function wtPath(p) {
	return `${SCRATCH}/${p.id}`;
}
function pieceBase(p) {
	return p.base || BASE;
}

function seedPrompt() {
	const WT = `${SCRATCH}/seed`;
	return (
		`You are the SEED thread for the unified Own the Mail pipeline. Create the unified integration branch \`${BASE}\` by merging the two old integration branches, open the new aggregate draft PR, and close the two old aggregate PRs. Work IN A DEDICATED WORKTREE; never touch the main checkout at ${ROOT} beyond \`git -C\` plumbing. NO AI attribution anywhere.\n\n` +
		`STEP 0 — REUSE CHECK: \`git -C "${ROOT}" fetch origin\`; \`git ls-remote --heads origin ${BASE}\`. If the branch EXISTS remotely: verify it contains both sources (\`git -C "${ROOT}" merge-base --is-ancestor origin/${INBOUND} origin/${BASE}\` and the same for origin/${WIRE}; exit code 0 = contained) and that the aggregate PR exists (\`gh pr list --repo ${REPO} --head ${BASE} --base ${MAIN} --state open --json number,url\`). If both hold, return created=true, reused=true with the PR number/url — done. If the branch exists but is missing a source branch's tip, merge the missing one in (same conflict policy as below) and push.\n\n` +
		`STEPS (fresh seed):\n` +
		`1. Worktree on the new branch, starting from the inbound side: \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" branch -D ${BASE} 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add -B ${BASE} "${WT}" origin/${INBOUND}\`.\n` +
		`2. Merge the wire side: \`git -C "${WT}" merge origin/${WIRE} -m "merge: unify ${INBOUND} + ${WIRE} into ${BASE}"\`. SIX conflicts are expected (audited 2026-07-16) — resolve them per the LOCKED unification decisions:\n` +
		`   - packages/mail-message/src/index.ts (add/add): the UNION of both files' exports — the two export lists are collision-free; keep both blocks with a "parse side" / "compose side" comment each.\n` +
		`   - packages/mail-message/package.json (add/add): name @owlat/mail-message, version 1.0.0, private, type module, main/types -> ./src/index.ts. exports: "." -> ./src/index.ts, "./headers" -> ./src/parse/headers.ts (the ONLY external consumer, packages/shared/src/mailMime.ts, wants the PARSE one — U0 retires this subpath properly right after; keep wire's "./compose", "./encoding", "./messageId" subpaths pointing at their current flat src/ files), devDependencies = union of both sides (identical catalog: entries plus wire's nodemailer/mailparser oracles), scripts = union (lint over src + __tests__). VERIFY with grep who imports each subpath before finalizing: \`git -C "${WT}" grep -l "@owlat/mail-message/" -- apps packages\`.\n` +
		`   - packages/mail-message/tsconfig.json (add/add): union of includes (src + __tests__).\n` +
		`   - packages/mail-message/vitest.config.ts (add/add): wire's include globs are the superset (covers both __tests__/ and src/**/__tests__/ conventions) — use them; coverage thresholds: KEEP the inbound side's >=90 line gates scoped to src/parse/** via per-glob thresholds if package-wide 90 would fail on the compose side (NEVER lower the parse gates; U0/R2 handle the ratchet).\n` +
		`   - .github/workflows/test.yml (content): the UNION of both sides' matrix insertions with a SINGLE mail-message entry, PLUS add a smtp-listener entry (missing on both branches — a known gap) so all four new packages run in CI.\n` +
		`   - bun.lock (content): resolve by REGENERATING — this is the sanctioned exception to the no-bun-install rule: \`cd "${WT}" && timeout 400 bun install\` (bun streams progress; do not run any build/test after it).\n` +
		`   Commit the resolution as part of the merge commit. If a conflict appears that is NOT in this list, resolve it by the same principle (both sides are intentional — union, never drop a side); if genuinely contradictory, abort the merge and return created=false with blockReason.\n` +
		`3. SANITY (watchdog-safe): \`cd "${WT}/packages/mail-message" && timeout 150 npx vitest run\` (node_modules exists from the bun install; this package's suite is small). If it fails, fix the union (imports/exports) until green — do NOT push a broken union.\n` +
		`4. Push: \`git -C "${WT}" push -u origin ${BASE}\`.\n` +
		`5. Open the aggregate DRAFT PR: \`gh pr create --repo ${REPO} --draft --base ${MAIN} --head ${BASE} --title "[DRAFT] Own the Mail — in-house SMTP client + listener, MIME composer + parser, mail-auth; four libraries removed" --body "<body>"\`. Body: DO-NOT-MERGE header (human-merged by Marcel; the pipeline only squash-merges piece PRs whose base is ${BASE}); the unification story (merges old #${OLD_AGG_INBOUND} + #${OLD_AGG_WIRE}; one mail-message with parse/ + compose/, ONE canon in mail-auth); the full piece checklist (wave 1 five landed pieces checked, then U0, S3, L3, P3, MD1, C0, CW1-CW4, CI1-CI4, R2, R1, X1-X4 optional, F1) with progress counts; a merge log section.\n` +
		`6. Close the old aggregate PRs (ONLY after step 5 succeeded): \`gh pr comment ${OLD_AGG_INBOUND} --repo ${REPO} --body "Superseded by the unified Own the Mail integration PR <url> — the two pipelines merged (both built packages/mail-message; DKIM canon was about to be built twice). ${INBOUND} is fully contained in ${BASE}; branch retained for history."\` then \`gh pr close ${OLD_AGG_INBOUND} --repo ${REPO}\`; same for #${OLD_AGG_WIRE} with its branch name.\n` +
		`7. Clean up: \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`Return the structured result (created, pushed, aggregatePrNumber/Url, closedOldPrs, conflictsResolved).`
	);
}

function buildPrompt(p) {
	if (p.id === 'F1') return f1BuildPrompt(p);
	const WT = wtPath(p);
	const base = pieceBase(p);
	const landing = base !== BASE;
	return (
		`You are the BUILDER thread for ONE own-the-mail piece. Implement it end-to-end IN A DEDICATED GIT WORKTREE with ATOMIC commits and open a PULL REQUEST against \`${base}\`${landing ? ' (an OLD integration branch — this is a wave-1 LANDING piece adopting an in-flight PR)' : ' (the unified integration branch — NOT ' + MAIN + ')'} on ${REPO}.\n\n` +
		CONV +
		`\n` +
		`PIECE: ${p.title}\nKIND: ${p.kind}\nBRANCH: ${p.branch}\nWORKTREE: ${WT}\n\n` +
		`STEP 0 — REUSE CHECK: run \`gh pr list --repo ${REPO} --head ${p.branch} --state open --json number,url,baseRefName\`. If an open PR already exists for this branch (base ${base}), DO NOT rebuild — return it with opened=true, reused=true, its number/url, and stop. ` +
		`Also check \`gh pr list --repo ${REPO} --head ${p.branch} --state merged --json number,url\` and spot-check whether the spec's key deliverables already exist on origin/${base} — a previous run may have merged this piece. If the work has ALREADY LANDED on ${base}, do NOT rebuild and do NOT open an empty-diff PR: return alreadyLanded=true, opened=false, prNumber=<the merged PR number or 0>, with a one-line summary. Otherwise continue.\n\n` +
		`SPEC:\n${p.spec}\n\n` +
		`TESTS (HARD GATE — the reviewer rejects the PR if any named test surface is missing):\n${p.tests}\n\n` +
		(p.focus ? `REVIEWER WILL FOCUS ON: ${p.focus}\n\n` : ``) +
		`STEPS:\n` +
		`1. Sync + make a CLEAN DEDICATED WORKTREE (never touch the main checkout):\n` +
		`   \`git -C "${ROOT}" fetch origin\`\n` +
		`   \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`\n` +
		`   \`git -C "${ROOT}" branch -D ${p.branch} 2>/dev/null || true\`\n` +
		`   \`git -C "${ROOT}" worktree add -B ${p.branch} "${WT}" origin/${base}\`\n` +
		`   Then do ALL edits under "${WT}" and ALL git ops with \`git -C "${WT}" …\`.\n` +
		`2. Read the ACTUAL current code first (spec file/line notes may have drifted — earlier pieces have already merged into ${base}; build on what is actually there). Then implement per the brief. ATOMIC commits (package code, tests, docs separate). NO AI attribution.\n` +
		`3. PREFLIGHT — run the local checks below and FIX everything they flag before pushing:\n${PREFLIGHT}` +
		`4. \`git -C "${WT}" push -u origin ${p.branch}\`.\n` +
		`5. Open the PR: \`gh pr create --repo ${REPO} --base ${base} --head ${p.branch} --title "<title>" --body "<body>"\`. Body: what changed and why (reference the shared product brief + the locked decision(s) this piece implements), the acceptance criteria as a checklist with honest check states, the NAMED TESTS and where each landed, an inventory of preserved behavior, ANY sanctioned semantics change enumerated with its fixture, and a final line: "Own-the-mail pipeline: squash-merges into ${base} on reviewer approval + green CI; ${BASE} -> ${MAIN} ships later as one human-merged PR (F1)." Capture the PR number + URL.\n` +
		`6. Clean up the worktree (leave the branch pushed): \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`GitHub Actions will verify the push — you do not wait for it. If you truly cannot complete the piece, still push what is coherent and open the PR as a draft (\`--draft\`) with blockReason in the body and opened=true, OR — if nothing shippable exists — set opened=false with blockReason. Return the structured result.`
	);
}

function f1BuildPrompt(p) {
	const WT = `${SCRATCH}/f1-final-sync`;
	return (
		`You are the BUILDER thread for F1 — finalizing THE ONE PR that ships the entire unified own-the-mail migration to ${MAIN}. The aggregate DRAFT PR (main <- ${BASE}) was opened by the seed step. You finalize it and STOP; a HUMAN squash-merges it. Do NOT merge anything.\n\n` +
		CONV +
		`\n` +
		`PIECE: ${p.title}\n\n` +
		`STEP 0 — FIND THE PR: \`gh pr list --repo ${REPO} --head ${BASE} --base ${MAIN} --state open --json number,url,isDraft\`. It should exist (the seed opened it). If it does NOT, create it as in the spec. Treat this as reused=true when found.\n\n` +
		`SPEC:\n${p.spec}\n\n` +
		`STEPS:\n` +
		`1. FINAL MAIN-SYNC IN A DEDICATED WORKTREE: \`git -C "${ROOT}" fetch origin\`; if \`git -C "${ROOT}" rev-list --count origin/${BASE}..origin/${MAIN}\` > 0, merge main into the integration branch in a scratch worktree: \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${BASE}\`; \`git -C "${WT}" merge origin/${MAIN} -m "merge: main into ${BASE} (final pre-ship sync)"\` (trunk wins on conflict — take main's structure, re-express the migration change on top; for apps/api/convex/_generated/api.d.ts keep BOTH sides' entries); \`git -C "${WT}" push origin HEAD:${BASE}\`; then remove the worktree.\n` +
		`2. AUDIT the integration branch head (read-only via \`git show origin/${BASE}:<path>\` / \`gh\`): every non-optional piece merged (check \`gh pr list --repo ${REPO} --base ${BASE} --state merged\` PLUS \`gh pr list --repo ${REPO} --base ${INBOUND} --state merged\` and \`--base ${WIRE}\` for the pre-unification pieces); no TODO(own-the-mail|own-the-wire|own-the-inbound) markers; \`git grep -i nodemailer origin/${BASE} -- apps/\` empty AND \`git grep -nE "smtp-server|mailparser|mailauth" origin/${BASE} -- apps/\` production-zero. Note any DROPPED optional X piece honestly. If a non-optional piece is missing or a grep is dirty, still finalize the PR but list the gap prominently in the body and in blockReason.\n` +
		`3. FINALIZE: \`gh pr ready <num> --repo ${REPO}\` (remove draft) and \`gh pr edit <num> --repo ${REPO} --body "<narrative>"\` per the spec's body requirements.\n` +
		`4. DO NOT MERGE. Return opened=true with the PR number + URL (branch=${BASE}).`
	);
}

function prStatePrompt(pr) {
	return (
		`Read-only check on PR #${pr} on ${REPO}: is the LAST substantive activity an unaddressed reviewer verdict?\n` +
		`Run \`gh pr view ${pr} --repo ${REPO} --json comments,commits\` and inspect chronology. The pipeline's reviewer posts comments containing "**Verdict: REQUEST_CHANGES**" or "**Verdict: APPROVE**"; the author replies with "## Author response" comments and/or new commits.\n` +
		`Set lastIsUnaddressedReview=true IFF the newest verdict comment says REQUEST_CHANGES AND there is NO author-response comment and NO commit AFTER it. Otherwise false. If true, list the concern bullets from that review in openConcerns. Do NOT modify anything.`
	);
}

function ciCheckPrompt(pr, iter) {
	return (
		`Report the current GitHub Actions status for PR #${pr} on ${REPO}. Poll ${iter}.\n` +
		`Run: \`timeout 120 gh pr checks ${pr} --repo ${REPO} --watch --interval 20 > /tmp/owlat_ci_${pr}.txt 2>&1; echo "RC=$?"\` (--watch exits when checks finish; the 120s timeout caps this poll under the watchdog). Then \`gh pr checks ${pr} --repo ${REPO}\` once and read the table.\n` +
		`Classify: state="pass" if every check is pass/skipping/neutral; "fail" if ANY check failed; "pending" if any is queued/in_progress and none failed; "unknown" if NONE reported yet. List failing check names. Do NOT modify anything.`
	);
}

function reviewPrompt(p, build, round) {
	if (p.id === 'F1') return f1ReviewPrompt(p, build, round);
	const base = pieceBase(p);
	return (
		`You are THE reviewer for PR #${build.prNumber} (${build.prUrl}) on ${REPO} (base branch: ${base}). Review ROUND ${round}. You are the single quality gate — you cover ALL areas below in one pass. The bar is: we only want the highest quality of code, and NO PIECE MERGES WITHOUT THE TESTS NAMED ON ITS CARD.\n\n` +
		`REVIEW AREAS (cover every one; area 0 is the hard test gate):\n${REVIEWER_FOCUS}\n\n` +
		`THE SHARED PRODUCT BRIEF this PR must conform to:\n${BRIEF}\n\n` +
		`The PR implements this piece of the unified own-the-mail plan — judge it against THIS intent:\nPIECE: ${p.title}\nSPEC:\n${p.spec}\nNAMED TESTS (the hard gate):\n${p.tests}\n` +
		(p.focus ? `EXTRA FOCUS FOR THIS PIECE: ${p.focus}\n` : ``) +
		`\nHOW TO REVIEW (read-only — do NOT checkout/modify the working tree or run the app):\n` +
		`- \`gh pr diff ${build.prNumber} --repo ${REPO}\` for the full diff; \`gh pr view ${build.prNumber} --repo ${REPO} --json title,body,commits,comments\` for context + prior-round comments.\n` +
		`- For full file context at the PR head without disturbing the tree: \`git fetch origin ${build.branch}\` then \`git show origin/${build.branch}:<path>\`. Read neighboring files on origin/${base} the same way for conventions context (e.g. apps/api/convex/CONVENTIONS.md, the old dataStream.ts / inboundDkim.ts / sender.ts a piece ports).\n` +
		(round > 1
			? `- This is a RE-REVIEW: FIRST check whether your prior round's findings (blocking AND improvements) were addressed in the new commits. New findings are allowed only if the fix commits introduced them or you find a genuinely new defect — do not drip-feed nits you could have raised earlier.\n`
			: ``) +
		`\nFINDINGS POLICY — two buckets, BOTH get fixed:\n` +
		`- blockingFindings: defects — the test gate unmet (any named differential/adversarial/integration/replay/golden surface missing or hollow), security/DoS issues (unbounded listener buffer or missing timeout, a hostile case not bounded, STARTTLS state not reset, an auth oracle, CRLF injection reachable, a DKIM verifier that can throw, l= not capped to neutral, forged-signature fail-open, SPF budget counting cache hits, DNS cache not failing open, credentials serialized pre-TLS, replay logging decoded bodies), a DOUBLE-DELIVERY path (post-DATA ambiguity classified retryable), a TLS-RPT truthfulness regression, a SECOND canonicalization implementation (U4 violation), a SILENT semantics change (any divergence from the old library not enumerated + fixture-pinned + signed off), a back-compat shim left behind, an oracle deleted from tests, failing CI causes.\n` +
		`- improvements: everything that would make this the highest-quality version of itself — code-smell hits from the catalog, best-practice deviations, naming, small simplifications, better types. These are NOT optional notes: the author is instructed to address every one. Only report CONCRETE, actionable items with file:line and the fix — no vague "consider..." advice, no pure-taste style preferences.\n\n` +
		`DECIDE: verdict="approve" ONLY if there are ZERO blocking findings AND ZERO unaddressed improvements AND the piece genuinely delivers its spec AND every named test surface exists and asserts the card's claims AND CI is not failing. If anything remains, verdict="request_changes" listing every item.\n\n` +
		`POST your review as ONE PR comment: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Review — round ${round}\\n\\n**Verdict: APPROVE|REQUEST_CHANGES**\\n\\n### Test gate\\n<met / unmet: which named tests are missing>\\n\\n### Blocking\\n<list or 'none'>\\n\\n### Improvements\\n<list or 'none'>"\` (markdown lists with file:line). Use a comment, NOT \`gh pr review\`: this pipeline's reviewer and author share one gh user, so a formal GitHub approval on your own PR is not possible — the explicit "**Verdict: APPROVE**" comment is how you record the verdict.\n\n` +
		`Then return the structured verdict (it drives the pipeline's approval gate).`
	);
}

function f1ReviewPrompt(p, build, round) {
	return (
		`You are the SHIP-READINESS reviewer for F1 — PR #${build.prNumber} (${build.prUrl}): main <- ${BASE}, the ENTIRE unified own-the-mail migration. Review ROUND ${round}. Every piece was already fully reviewed on its own PR — do NOT re-review every line. Your job is COMPLETENESS + SHIP-READINESS.\n\n` +
		`CHECK:\n` +
		`1) COMPLETENESS: every non-optional piece present on the head — the five wave-1 landings (L2 #364, P2 #362, A2 #363 into ${INBOUND}; M2 #361, S2 #360 into ${WIRE}, carried over by the seed merge) plus U0, S3, L3, P3, MD1, C0, CW1, CW2, CW3, CW4, CI1, CI2, CI3, CI4, R2, R1. \`gh pr view ${build.prNumber} --repo ${REPO} --json body,commits\`; cross-check \`gh pr list --repo ${REPO} --base ${BASE} --state merged\` plus the two old branches' merged lists. Optional X pieces: verify any dropped capability is HONESTLY noted in the body.\n` +
		`2) REMOVAL PROOF: \`git fetch origin ${BASE}\` then \`git grep -in nodemailer origin/${BASE} -- apps/\` empty AND \`git grep -nE "smtp-server|mailparser|mailauth" origin/${BASE} -- apps/\` production-zero (tests/devDeps only); no TODO(own-the-mail|own-the-wire|own-the-inbound) markers remain.\n` +
		`3) CI: \`gh pr checks ${build.prNumber} --repo ${REPO}\` — full ci:verify GREEN on the MERGED tree (every package suite + replay + differential + golden-corpus jobs). BLOCK on FAILED; do not block on pending.\n` +
		`4) PR BODY: the narrative is present and honest — unified-plan framing, per-piece table linking each PR + review across ALL THREE branches, the enumerated sanctioned improvements, payoff + risk checklists, one-week watch plan, HUMAN-MERGE-ONLY note, draft flag removed.\n\n` +
		`blockingFindings = any missing non-optional piece, dirty removal grep, failing CI, or a materially incomplete/misleading PR body. improvements = body/table polish. verdict="approve" only when all four hold.\n` +
		`POST ONE comment: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Ship-readiness review — round ${round}\\n\\n**Verdict: APPROVE|REQUEST_CHANGES**\\n\\n<completeness / removal proof / CI / body>"\`. Then return the structured verdict. Approve here means READY FOR MARCEL TO MERGE — the pipeline still does NOT merge F1.`
	);
}

function addressPrompt(p, build, review, ci, round) {
	const WT = wtPath(p);
	const base = pieceBase(p);
	const fmt = (arr) =>
		(arr || []).map((f) => `- ${f.file}${f.line ? ':' + f.line : ''} — ${f.issue}`).join('\n');
	const findings = review
		? `### Blocking\n${fmt(review.blockingFindings) || '(none)'}\n\n### Improvements (address these too — they are not optional)\n${fmt(review.improvements) || '(none)'}`
		: '';
	const ciNote =
		ci && ci.state === 'fail'
			? `\nGitHub CI is currently FAILING: ${ci.failing.join(', ')}. Investigate via \`gh pr checks ${build.prNumber} --repo ${REPO}\` and the linked job logs, and fix the cause.\n`
			: '';
	return (
		`You are the AUTHOR thread for PR #${build.prNumber} (${build.prUrl}) on ${REPO}, branch ${build.branch}, base ${base}. Address the reviewer's ACTUAL PR comments and push fixes IN A DEDICATED WORKTREE. Fix ROUND ${round}.\n\n` +
		CONV +
		`\n` +
		`PIECE: ${p.title}\nSPEC (intent to preserve):\n${p.spec}\n\nNAMED TESTS (hard gate — if the reviewer says one is missing, ADD it):\n${p.tests}\n\n` +
		`FINDINGS TO RESOLVE — address EVERY item, including the small improvements (the bar is the highest-quality version of this change, not merely a passing one):\n${findings || '(re-read the live PR comments)'}\n${ciNote}\n` +
		`Also read live comments: \`gh pr view ${build.prNumber} --repo ${REPO} --json comments\`.\n\n` +
		`STEPS:\n` +
		`1. Clean DEDICATED worktree at the PR head: \`git -C "${ROOT}" fetch origin ${build.branch}\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${build.branch}\`; then work under "${WT}" with \`git -C "${WT}"\`. (Detached HEAD is fine — you push explicitly.)\n` +
		`2. Fix each blocking finding (and any CI failure). If you believe a finding is wrong, that is allowed — justify it in the PR response and in \`unresolved\`. ATOMIC commits, NO AI attribution.\n` +
		`3. PREFLIGHT before re-pushing — run the local checks below and fix everything they flag:\n${PREFLIGHT}` +
		`4. Push: \`git -C "${WT}" push origin HEAD:${build.branch}\`. Post a response: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Author response — round ${round}\\n\\n<what you addressed per reviewer + anything intentionally unchanged with reason>"\`. Then \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`Return the structured result.`
	);
}

function mergePrompt(p, build, approved, ci) {
	const WT = wtPath(p);
	const base = pieceBase(p);
	const green = ci && ci.state === 'pass';
	const ready = approved && green;
	return (
		`You are the MERGE gate for PR #${build.prNumber} (${build.prUrl}) on ${REPO}, branch ${build.branch}, BASE BRANCH ${base} (an integration branch — this pipeline NEVER merges to ${MAIN}). The unified reviewer ${approved ? 'posted an APPROVE verdict' : 'did NOT post an APPROVE verdict within the round budget'}; GitHub CI state is "${ci ? ci.state : 'unknown'}"${ci && ci.failing && ci.failing.length ? ' (failing: ' + ci.failing.join(', ') + ')' : ''}.\n\n` +
		(ready
			? `BOTH gates are met (reviewer APPROVE verdict + CI green). Per this pipeline's design, an approved + green PIECE PR is squash-merged into its integration base ${base} — never into ${MAIN} (the unified branch reaches ${MAIN} only through F1, which a human reviews and merges). NOTE ON REVIEW IDENTITY: the reviewer and author run under the same gh user, so the "**Verdict: APPROVE**" PR comment — not a formal GitHub approval — is the recorded approval; treat it as the go signal. MERGE the PR now:\n` +
				`1. FIRST verify the base: \`gh pr view ${build.prNumber} --repo ${REPO} --json baseRefName\` must say ${base} — if it says anything else (especially ${MAIN}), DO NOT merge; return merged=false with the reason.\n` +
				`2. \`gh pr merge ${build.prNumber} --repo ${REPO} --squash --delete-branch\`.\n` +
				`3. If it fails because the branch is BEHIND ${base} (possible — sibling pieces merge in parallel), attempt ONE CLEAN rebase in a DEDICATED WORKTREE (never touch the main checkout): \`git -C "${ROOT}" fetch origin\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${build.branch}\`; \`git -C "${WT}" rebase origin/${base}\`.\n` +
				`   - If the rebase completes with NO conflicts: \`git -C "${WT}" push --force-with-lease origin HEAD:${build.branch}\`, remove the worktree, retry the merge (repeat this clean-rebase+retry up to TWO times — parallel merges race).\n` +
				`   - If the rebase STOPS ON CONFLICTS: capture the conflicted paths FIRST (\`git -C "${WT}" diff --name-only --diff-filter=U\`), then \`git -C "${WT}" rebase --abort\`, remove the worktree, and return merged=false, conflict=true, conflictFiles=<those paths>. Do NOT hand-resolve — a dedicated resolver thread handles that.\n` +
				`4. Confirm merged: \`gh pr view ${build.prNumber} --repo ${REPO} --json state,mergeCommit\`. Return merged=true with the merge commit only if state=MERGED.\n` +
				`If the merge cannot complete for a NON-conflict reason (protected-branch block, API error), return merged=false, conflict=false with the reason in outstanding — do NOT force anything unsafe.\n`
			: `NOT ready to merge (${approved ? 'CI not green' : 'no APPROVE verdict'}). DO NOT MERGE. Post a PR comment summarizing exactly what still blocks merge (outstanding findings and/or failing checks) so a human can pick it up, and return merged=false with those items in \`outstanding\`.\n`) +
		`Return the structured result.`
	);
}

function resolveConflictPrompt(p, build, conflictFiles, attempt) {
	const WT = `${wtPath(p)}-resolve`;
	const base = pieceBase(p);
	return (
		`You are the CONFLICT RESOLVER for PR #${build.prNumber} (${build.prUrl}) on ${REPO}, branch ${build.branch}, base ${base}. Attempt ${attempt}. The merge gate found the branch conflicts with ${base} after sibling pieces of this pipeline merged. Your job: rebase the branch onto origin/${base} IN A DEDICATED WORKTREE and resolve every conflict SEMANTICALLY — you have the piece's full spec below, and the conflicting changes on ${base} come from sibling pieces of the same unified plan, so BOTH sides are intentional and BOTH intents must survive.\n\n` +
		CONV +
		`\n` +
		`PIECE (this branch's intent): ${p.title}\nSPEC:\n${p.spec}\n\n` +
		`KNOWN CONFLICTED FILES (from the merge gate's probe): ${conflictFiles && conflictFiles.length ? conflictFiles.join(', ') : '(unknown — discover during rebase)'}\n\n` +
		`STEPS:\n` +
		`1. Dedicated worktree (never touch the main checkout): \`git -C "${ROOT}" fetch origin\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${build.branch}\`; then \`git -C "${WT}" rebase origin/${base}\`.\n` +
		`2. UNDERSTAND BEFORE RESOLVING each conflicted file: read the full conflicted file, then BOTH parents — \`git -C "${WT}" show REBASE_HEAD:<path>\` (this branch) and \`git -C "${WT}" show origin/${base}:<path>\` (what landed) — plus \`git -C "${WT}" log --oneline -8 origin/${base} -- <path>\` to see WHICH sibling piece changed it and why.\n` +
		`3. RESOLUTION POLICY: preserve BOTH behaviors — the sibling piece's merged change AND this piece's spec'd change. Never delete either side to make the conflict go away. If both sides restructured the same code incompatibly, keep ${base}'s structure as the base and RE-EXPRESS this piece's intent on top of it. If a conflict reveals the two pieces genuinely contradict, STOP: return resolved=false with blockReason naming both sides.\n` +
		`4. Continue the rebase to completion (\`git -C "${WT}" rebase --continue\` after each resolved commit; keep the atomic-commit structure — do NOT squash during resolution).\n` +
		`5. PREFLIGHT the files you touched (oxfmt + oxlint as below) and self-review types:\n${PREFLIGHT}` +
		`6. Push: \`git -C "${WT}" push --force-with-lease origin HEAD:${build.branch}\`. Post a PR comment: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Conflict resolution\\n\\nRebased onto ${base}; resolved: <files + one line each on how both intents were preserved>"\`. Clean up: \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`GitHub Actions re-verifies the force-push — you do not wait for it. Return the structured result (resolved, pushed, files touched).`
	);
}

function mainSyncPrompt(waveNo) {
	const WT = `${SCRATCH}/main-sync-w${waveNo}`;
	return (
		`You are the MAIN-SYNC thread for the own-the-mail pipeline, after wave ${waveNo}. FRESHNESS RULE: merge origin/${MAIN} INTO the unified integration branch ${BASE} so the final giant PR stays reviewable instead of a mega-conflict. Do it IN A DEDICATED WORKTREE. TRUNK WINS on conflict — but "wins" means main's version is the BASE STRUCTURE; re-express the migration change on top of it, never silently drop a migration behavior.\n\n` +
		`STEPS (never touch the main checkout at ${ROOT} beyond \`git -C\` commands):\n` +
		`1. \`git -C "${ROOT}" fetch origin\`. Check whether a merge is even needed: \`git -C "${ROOT}" rev-list --count origin/${BASE}..origin/${MAIN}\` — if 0, return merged=true, pushed=false, conflicts=[], summary="integration branch already contains main".\n` +
		`2. \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${BASE}\` (detached); \`git -C "${WT}" merge origin/${MAIN} -m "merge: main into ${BASE} (post-wave ${waveNo} freshness sync)"\`.\n` +
		`3. If conflicts: resolve per the trunk-wins policy — for each conflicted file read both sides (\`git -C "${WT}" show HEAD:<path>\` vs \`git -C "${WT}" show origin/${MAIN}:<path>\`), take main's structure, re-apply the migration intent on top, \`git add\` and complete the merge commit. If apps/api/convex/_generated/api.d.ts conflicts, regenerate the union by hand (keep BOTH sides' module entries — additive). If bun.lock conflicts, regenerate it (\`cd "${WT}" && timeout 400 bun install\` — sanctioned for sync threads). Preflight-format any file you hand-edited (\`oxfmt --config "${ROOT}/oxfmtrc.json" --write <files>\`).\n` +
		`4. Push: \`git -C "${WT}" push origin HEAD:${BASE}\`. Clean up: \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n` +
		`5. If a conflict is genuinely unresolvable without dropping one side's behavior, abort the merge, push NOTHING, and return merged=false with blockReason — a human decides.\n\n` +
		`NO AI attribution in the merge commit. Return the structured result (merged, pushed, conflicts=<files that had conflicts>, summary).`
	);
}

// ===========================================================================
// Orchestrator helpers
// ===========================================================================

// Review PREFERS Fable, with a NON-STICKY per-review fallback to Opus: each
// review tries Fable first; if that Fable review returns null (transient
// unavailability / usage), Opus covers THAT review only and the next review
// tries Fable again.
async function runReview(p, build, round) {
	const opts = {
		label: `review:${p.id}:r${round}`,
		phase: 'Review',
		schema: REVIEW_SCHEMA,
		effort: 'high',
	};
	let review = await agent(reviewPrompt(p, build, round), { ...opts, model: 'fable' });
	if (!review) {
		log(
			`${p.id} review r${round}: Fable returned null — Opus covers THIS review only; next review retries Fable`
		);
		review = await agent(reviewPrompt(p, build, round), { ...opts, model: 'opus' });
	}
	return review;
}

async function waitForCi(prNumber, pieceId) {
	let last = null;
	for (let i = 0; i < CI_POLLS; i++) {
		const s = await agent(ciCheckPrompt(prNumber, i + 1), {
			label: `ci:${pieceId}:${i + 1}`,
			phase: 'Verify',
			schema: CI_SCHEMA,
			model: 'sonnet',
			effort: 'low',
		});
		if (!s) continue;
		last = s;
		if (s.state === 'pass' || s.state === 'fail') {
			log(`${pieceId} CI: ${s.state}`);
			return s;
		}
	}
	log(`${pieceId} CI: timed out waiting (last=${last ? last.state : 'none'})`);
	return last || { state: 'unknown', failing: [], summary: 'no CI status obtained' };
}

// Full lifecycle for ONE piece: build -> CI -> review<->address loop -> merge.
// F1 (humanMerge) stops at approved+green. Never throws (parallel siblings must
// not die together).
async function runPiece(p, idx, total, mergedSet) {
	const failedDeps = (p.dependsOn || []).filter((d) => !mergedSet.has(d));
	if (failedDeps.length) {
		log(`${p.id} — SKIPPED (unmerged deps: ${failedDeps.join(', ')})`);
		return {
			piece: p.id,
			opened: false,
			merged: false,
			optional: !!p.optional,
			reason: 'skipped: unmerged deps ' + failedDeps.join(','),
		};
	}
	const autoMerge = AUTO_MERGE && !p.humanMerge;
	log(`[${idx}/${total}] ${p.id} — building`);
	try {
		const build = await agent(buildPrompt(p), {
			label: `build:${p.id}`,
			phase: 'Build',
			schema: BUILD_SCHEMA,
			model: 'opus',
			effort: 'medium',
		});
		if (build && build.alreadyLanded) {
			log(
				`${p.id} already landed on ${pieceBase(p)} (PR #${build.prNumber || '?'}) — counting as merged`
			);
			return {
				piece: p.id,
				opened: false,
				merged: true,
				prNumber: build.prNumber,
				reason: 'already landed on ' + pieceBase(p),
			};
		}
		if (!build || !build.opened || !build.prNumber) {
			log(`build failed for ${p.id}: ${(build && build.blockReason) || 'agent died / rate limit'}`);
			return {
				piece: p.id,
				opened: false,
				merged: false,
				optional: !!p.optional,
				reason: (build && build.blockReason) || 'build agent failed',
			};
		}
		log(`${p.id} -> PR #${build.prNumber}${build.reused ? ' (reused)' : ''} ${build.prUrl}`);

		// ADOPTED PR: a previous run (or the pre-unification pipelines, for the
		// wave-1 landing pieces) may have left a reviewer verdict as the last word
		// on the PR. If so, address its concerns FIRST.
		if (build.reused) {
			const st = await agent(prStatePrompt(build.prNumber), {
				label: `pr-state:${p.id}`,
				phase: 'Verify',
				schema: PR_STATE_SCHEMA,
				model: 'sonnet',
				effort: 'low',
			});
			if (st && st.lastIsUnaddressedReview) {
				log(
					`${p.id} adopted PR has an unaddressed review (${(st.openConcerns || []).length} concerns) — addressing before re-review`
				);
				await agent(addressPrompt(p, build, null, null, 0), {
					label: `address:${p.id}:adopted`,
					phase: 'Address',
					schema: ADDRESS_SCHEMA,
					model: 'opus',
					effort: 'medium',
				});
			}
		}

		// GitHub Actions verifies the pushed build before reviewing.
		let ci = await waitForCi(build.prNumber, p.id);

		// Unified reviewer (Fable, per-review Opus fallback) <-> Opus author loop
		// until approve AND CI green.
		let approved = false;
		for (let round = 1; round <= MAX_ROUNDS; round++) {
			const review = await runReview(p, build, round);
			const ok = !!review && review.verdict === 'approve';
			const openItems = review
				? (review.blockingFindings || []).length + (review.improvements || []).length
				: -1;
			log(
				`${p.id} round ${round}: ${ok ? 'APPROVE' : review ? `request_changes (${openItems} items)` : 'reviewer died'}; CI=${ci.state}`
			);
			if (ok && ci.state === 'pass') {
				approved = true;
				break;
			}
			if (round === MAX_ROUNDS) {
				approved = ok;
				// INVARIANT: a request_changes review is NEVER the last word on a PR.
				if (!ok && review) {
					log(
						`${p.id} round budget spent with open findings — final address pass so the review does not go unanswered`
					);
					await agent(addressPrompt(p, build, review, ci, round + 1), {
						label: `address:${p.id}:final`,
						phase: 'Address',
						schema: ADDRESS_SCHEMA,
						model: 'opus',
						effort: 'medium',
					});
					ci = await waitForCi(build.prNumber, p.id);
				}
				break;
			}

			await agent(addressPrompt(p, build, review, ci, round + 1), {
				label: `address:${p.id}:r${round + 1}`,
				phase: 'Address',
				schema: ADDRESS_SCHEMA,
				model: 'opus',
				effort: 'medium',
			});
			ci = await waitForCi(build.prNumber, p.id);
		}

		// F1 is human-merged: stop at approved+green, report for Marcel, never merge.
		if (p.humanMerge) {
			const shipReady = approved && ci.state === 'pass';
			log(
				`${p.id} ${shipReady ? 'READY FOR HUMAN MERGE' : 'NOT ship-ready'} (approved=${approved}, ci=${ci.state}) — PR ${build.prUrl}`
			);
			return {
				piece: p.id,
				opened: true,
				reused: !!build.reused,
				prNumber: build.prNumber,
				prUrl: build.prUrl,
				approved,
				ciState: ci.state,
				merged: false,
				humanMerge: true,
				shipReady,
				outstanding: shipReady ? [] : ['awaiting approval + green CI before human merge'],
			};
		}

		// Merge on approve+green; a detected CONFLICT spawns a dedicated Opus
		// resolver, CI re-verifies, then the merge retries.
		let merged = false;
		let mergeOut = [];
		if (autoMerge) {
			for (let attempt = 1; attempt <= MERGE_ATTEMPTS && !merged; attempt++) {
				const m = await agent(mergePrompt(p, build, approved, ci), {
					label: `merge:${p.id}:a${attempt}`,
					phase: 'Merge',
					schema: MERGE_SCHEMA,
					model: 'sonnet',
					effort: 'low',
				});
				merged = !!(m && m.merged);
				mergeOut = (m && m.outstanding) || [];
				if (merged || !(m && m.conflict)) break;

				log(
					`${p.id} merge blocked by CONFLICT (attempt ${attempt}): ${(m.conflictFiles || []).join(', ') || 'files unknown'} — spawning resolver`
				);
				const res = await agent(resolveConflictPrompt(p, build, m.conflictFiles || [], attempt), {
					label: `resolve:${p.id}:a${attempt}`,
					phase: 'Merge',
					schema: RESOLVE_SCHEMA,
					model: 'opus',
					effort: 'medium',
				});
				if (!res || !res.pushed) {
					mergeOut = ['conflict resolution failed: ' + ((res && res.blockReason) || 'resolver died')];
					log(`${p.id} resolver did not push — leaving for human (${mergeOut[0]})`);
					break;
				}

				// A force-push from the resolver re-runs CI from scratch and can be slow
				// on this repo. Only a genuine FAIL warrants a repair pass; pending just
				// means CI has not settled — EXTEND the wait rather than abandoning an
				// otherwise-mergeable PR.
				ci = await waitForCi(build.prNumber, p.id);
				if (ci.state === 'fail') {
					await agent(addressPrompt(p, build, null, ci, MAX_ROUNDS + attempt), {
						label: `address:${p.id}:post-resolve${attempt}`,
						phase: 'Address',
						schema: ADDRESS_SCHEMA,
						model: 'opus',
						effort: 'medium',
					});
					ci = await waitForCi(build.prNumber, p.id);
				}
				for (let extra = 0; extra < 3 && (ci.state === 'pending' || ci.state === 'unknown'); extra++) {
					log(`${p.id} post-resolve CI still ${ci.state} — extending wait (${extra + 1}/3)`);
					ci = await waitForCi(build.prNumber, p.id);
				}
				if (ci.state !== 'pass') {
					mergeOut = [`CI ${ci.state} after conflict resolution`];
					log(`${p.id} CI ${ci.state} after post-resolve — leaving for human`);
					break;
				}
			}
			log(
				`${p.id} ${merged ? 'MERGED into ' + pieceBase(p) : 'NOT merged'}${merged ? '' : ' — ' + mergeOut.join('; ')}`
			);
		} else {
			log(`${p.id} approve=${approved} ci=${ci.state} — AUTO_MERGE off, leaving for human`);
		}
		return {
			piece: p.id,
			opened: true,
			reused: !!build.reused,
			prNumber: build.prNumber,
			prUrl: build.prUrl,
			approved,
			ciState: ci.state,
			merged,
			optional: !!p.optional,
			outstanding: mergeOut,
		};
	} catch (e) {
		log(`${p.id} FAILED (caught): ${String(e).slice(0, 160)} — continuing`);
		return {
			piece: p.id,
			opened: false,
			merged: false,
			optional: !!p.optional,
			reason: 'caught: ' + String(e).slice(0, 140),
		};
	}
}

// ===========================================================================
// Driver — explicit WAVES of parallel TRACKS (serial inside a track). Waves are
// barriers. Wave 1 lands the five in-flight PRs into their OLD bases; the SEED
// step then creates the unified branch; after each later wave with >=1 merge,
// origin/main is merged INTO the unified branch (trunk wins). On a
// rate-limit/stall resume: add merged ids to MERGED_IDS and relaunch FRESH —
// the reuse-check adopts still-open PRs and the seed's reuse-check adopts the
// existing unified branch. TRUST `gh pr list --state merged` over a resumed
// run's cached result JSON.
// ===========================================================================
const byId = Object.fromEntries(PIECES.map((p) => [p.id, p]));
const MERGED_IDS = [
	// Add piece ids here when resuming a partial run (verify against
	// `gh pr list --base <branch> --state merged` first).
];
const RUN_WAVES = WAVES.map((wave) =>
	wave
		.map((track) => track.filter((id) => !MERGED_IDS.includes(id)))
		.filter((track) => track.length > 0)
).filter((wave) => wave.length > 0);

const total = RUN_WAVES.flat(2).length;
log(
	`own-the-mail-prs: ${total} piece(s) in ${RUN_WAVES.length} wave(s) (auto-merge=${AUTO_MERGE}) vs ${REPO}, unified base ${BASE}`
);
RUN_WAVES.forEach((w, i) => log(`wave ${i + 1}: ${w.map((t) => t.join(' -> ')).join(' | ')}`));

const results = [];
const mergedSet = new Set(MERGED_IDS);
let counter = 0;
let seeded = false;

async function runSeed() {
	phase('Seed');
	const seed = await agent(seedPrompt(), {
		label: 'seed:unify-branches',
		phase: 'Seed',
		schema: SEED_SCHEMA,
		model: 'opus',
		effort: 'high',
	});
	if (!seed || !seed.created) {
		log(
			`SEED FAILED: ${(seed && seed.blockReason) || 'agent died'} — ABORTING (nothing can target ${BASE} until the unified branch exists). Fix and resume: wave-1 pieces already merged go into MERGED_IDS; the seed reuse-check adopts a half-created branch.`
		);
		return false;
	}
	log(
		`SEED ${seed.reused ? 'reused existing' : 'created'} ${BASE}; aggregate PR #${seed.aggregatePrNumber} ${seed.aggregatePrUrl || ''}; old PRs closed=${seed.closedOldPrs}${(seed.conflictsResolved || []).length ? '; conflicts resolved: ' + seed.conflictsResolved.join(', ') : ''}`
	);
	return true;
}

for (let w = 0; w < RUN_WAVES.length; w++) {
	const wave = RUN_WAVES[w];
	const waveIds = wave.flat();
	phase(`Wave ${w + 1}`);
	log(`=== wave ${w + 1}/${RUN_WAVES.length}: ${wave.map((t) => t.join(' -> ')).join(' | ')} ===`);

	// The seed must run before any piece that targets the unified branch. It sits
	// after the landing wave; if MERGED_IDS filtering removed that wave entirely,
	// seed before the first unified-base wave instead.
	const waveNeedsUnifiedBase = waveIds.some((id) => pieceBase(byId[id]) === BASE);
	if (!seeded && waveNeedsUnifiedBase) {
		const ok = await runSeed();
		if (!ok) break;
		seeded = true;
	}

	// Tracks in parallel; pieces inside a track serially.
	const waveResults = await parallel(
		wave.map((track) => async () => {
			const trackResults = [];
			for (const id of track) {
				counter++;
				const r = await runPiece(byId[id], counter, total, mergedSet);
				trackResults.push(r);
				if (r && r.merged) mergedSet.add(r.piece);
			}
			return trackResults;
		})
	);

	for (const r of waveResults.filter(Boolean).flat()) results.push(r);

	const waveMergedCount = waveResults
		.filter(Boolean)
		.flat()
		.filter((r) => r && r.merged).length;
	const wavePieceCount = waveIds.length;
	log(`wave ${w + 1} done: ${waveMergedCount}/${wavePieceCount} merged`);

	// The F1 wave never "merges" (human does); the all-optional X wave failing
	// must not abort the run — F1 does not depend on it.
	const isF1Wave = waveIds.length === 1 && waveIds[0] === 'F1';
	if (isF1Wave) continue;
	const allOptional = waveIds.every((id) => byId[id] && byId[id].optional);

	if (
		ABORT_IF_WHOLE_WAVE_FAILS &&
		!allOptional &&
		wavePieceCount > 1 &&
		waveMergedCount === 0
	) {
		log(
			`ABORT: entire wave ${w + 1} failed to merge — likely rate limit or systemic issue. Fix and resume via MERGED_IDS.`
		);
		break;
	}

	// Freshness rule: after each post-seed wave with merges, fold main INTO the
	// unified integration branch (trunk wins) so the final giant PR stays
	// reviewable. The landing wave merges into the OLD branches — the seed merge
	// right after it is its freshness step.
	if (seeded && waveMergedCount > 0) {
		phase(`Sync ${w + 1}`);
		const sync = await agent(mainSyncPrompt(w + 1), {
			label: `main-sync:w${w + 1}`,
			phase: `Sync ${w + 1}`,
			schema: SYNC_SCHEMA,
			model: 'opus',
			effort: 'medium',
		});
		if (!sync || !sync.merged) {
			log(
				`main-sync after wave ${w + 1} FAILED: ${(sync && sync.blockReason) || 'agent died'} — STOPPING so the divergence is handled by a human before more pieces stack on top`
			);
			break;
		}
		log(
			`main-sync after wave ${w + 1}: ${sync.pushed ? 'merged + pushed' : 'nothing to merge'}${(sync.conflicts || []).length ? ' (conflicts resolved: ' + sync.conflicts.join(', ') + ')' : ''}`
		);
	}
}

const mergedCount = results.filter((r) => r.merged).length;
const f1 = results.find((r) => r.piece === 'F1');
const droppedOptional = results.filter((r) => r.optional && !r.merged).map((r) => r.piece);
const openedNotMerged = results.filter((r) => r.opened && !r.merged && r.piece !== 'F1');
log(
	`DONE — ${mergedCount}/${total - 1} pieces merged; ${openedNotMerged.length} opened-but-unmerged; dropped optional capabilities: ${droppedOptional.length ? droppedOptional.join(', ') : 'none'}. ` +
		(f1 && f1.opened
			? `F1 (the ONE PR to ${MAIN}) is ${f1.shipReady ? 'READY FOR MARCEL TO SQUASH-MERGE' : 'OPEN but not yet ship-ready'}: ${f1.prUrl}`
			: `F1 (the ONE PR to ${MAIN}) was not finalized — check the log.`)
);
return {
	repo: REPO,
	base: BASE,
	mergedCount,
	total,
	droppedOptional,
	f1: f1 || null,
	waves: RUN_WAVES.map((w) => w.map((t) => t.join('->'))),
	results,
};
