export const meta = {
	name: 'sealed-mail-prs',
	description:
		'Auto-merging per-piece PR pipeline for the 2026-07-11 Sealed Mail plan (E2EE between Owlat instances + sender-auth badges + transport hardening): 21 test-gated pieces on the integration/sealed-mail branch, merged to main later as ONE giant human-merged PR. For each piece: one BUILDER thread (Opus) implements it IN A DEDICATED GIT WORKTREE (off origin/integration/sealed-mail) with atomic commits and opens a PR targeting integration/sealed-mail; GitHub Actions verifies the push; ONE unified reviewer thread (Fable, latching to Opus if Fable dies) reviews Security + Code Quality + Functionality/Tests + the Fowler code-smell catalog + per-stack best practices AND ENFORCES THE HARD TEST GATE (a piece PR missing the test files named on its card is rejected); the AUTHOR thread (Opus) loops addressing EVERY finding until the reviewer approves; then — on approval AND green GitHub CI — a MERGE thread (Sonnet) squash-merges the PR into the integration branch. Waves are barriers; tracks within a wave run in parallel, pieces within a track run serially (in-wave dependency chains). After each wave, main is merged INTO the integration branch (trunk wins). The pipeline NEVER merges to main.',
	phases: [
		{
			title: 'Build',
			detail: 'Opus builders open PRs vs integration/sealed-mail from scratchpad worktrees',
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
			detail: 'approved + CI green -> Sonnet squash-merge into the integration branch',
			model: 'sonnet',
		},
		{
			title: 'Sync',
			detail: 'after each wave: merge main INTO integration/sealed-mail (trunk wins)',
			model: 'opus',
		},
	],
};

// ===========================================================================
// Constants
// ===========================================================================
const REPO = 'wolvesdotink/owlat'; // public OSS repo == `origin` remote
const BASE = 'integration/sealed-mail'; // piece PRs target THIS branch (never main)
const MAIN = 'main'; // merged INTO the integration branch after each wave
const MAX_ROUNDS = 4; // review<->address rounds before escalating to a human
const CI_POLLS = 8; // bounded CI-wait iterations (~120s each)
const ROOT = '/Users/marcel/Code/WLS - wolves/owlat';
const SCRATCH =
	'/private/tmp/claude-501/-Users-marcel-Code-WLS---wolves-owlat/385b82d6-4241-4d94-85ed-6ab45315418e/scratchpad/sealed-mail-wt';
const AUTO_MERGE = true; // squash-merge into the integration branch on approve+green
const MERGE_ATTEMPTS = 3; // merge tries per piece; a conflict spawns an Opus resolver between tries
const ABORT_IF_WHOLE_WAVE_FAILS = true;

// ===========================================================================
// THE PRODUCT BRIEF — shared by every builder/reviewer so 21 independent PRs
// converge on ONE feature. Locked decisions D1-D8 come from the grilled design
// plan of 2026-07-11 (sealed-mail-plan.html); deviations are review-blocking.
// ===========================================================================
const BRIEF =
	`PRODUCT BRIEF — "Sealed Mail" (2026-07-11 plan: E2EE between Owlat instances + sender authenticity + transport security):\n` +
	`GOAL: a message between two Owlat instances is ciphertext on the wire and at rest, renders with an honest "Sealed - sender verified" badge, a spoofed sender shows "not authorized to send for <domain>" in the reader, and the instance publishes/verifies MTA-STS, TLS-RPT, DANE and WKD. Postbox 1:1 plane only. Minimal and functional; follow the existing Fluid Functionalism design system.\n` +
	`LOCKED DECISIONS (do not relitigate; veto window closed for implementation):\n` +
	`D1. PGP/MIME (OpenPGP, RFC 9580 profile) via openpgp.js — the ONE new dependency, added in P0.\n` +
	`D2. AUTO-SEAL when all recipients have usable keys; org-level policy override (auto / ask / off). Seal ONLY when ALL recipients have keys — never a mixed send.\n` +
	`D3. DECRYPT-ON-INGEST: plaintext flows into the normal pipeline (categorize, needs-reply, agent, knowledge, search all keep working); the sealed original is retained as the raw .eml. E8b then seals ALL bodies at rest uniformly.\n` +
	`D4. Protected headers ON; outer subject is the literal placeholder "..." (three dots), real subject travels inside.\n` +
	`D5. POSTBOX 1:1 PLANE ONLY (human + agent mail); campaigns/transactional stay plaintext and untouched.\n` +
	`D6. DANE behind DANE_ENABLED (default off); resolver = configured DoH/validating upstream trusting the AD bit (AD absent => treated as "no TLSA"); a local validating resolver is the documented production recommendation.\n` +
	`D7. RECOVERY KIT ONLY; no admin escrow of private keys, ever.\n` +
	`D8. Not serialized behind own-the-wire; T5/REQUIRETLS stays parked there. E9 (client-held keys / locked threads) is OUT of this integration branch entirely.\n` +
	`HONESTY AUDIT IS A TEST, NOT A VIBE: badge/lock copy is asserted VERBATIM in component tests; a state may never claim more than what was cryptographically checked (e.g. "Sealed - sender verified" is only reachable when signatureValid && pinnedFingerprintMatch).\n` +
	`THE "EVERYTHING TESTED" CONTRACT: every piece card names its test files — that list is the merge gate. vitest only (never bun test); convex-test for backend; interop fixtures live in fixtures/sealed-mail/ (checked in as bytes, generated offline — CI never needs gpg).\n` +
	`FLAGS ON THIS BRANCH: senderAuthBadges and sealedMail both default OFF here; defaults flip in a dedicated commit at final-PR time, not in piece PRs.\n` +
	`UI RULES: FF design tokens from packages/ui/assets/css exclusively (no hardcoded hex/shadow/duration); dark AND light themes; human copy (plain-language security wording — explain, never lecture; no crypto jargon in user-facing strings beyond the agreed badge copy); empty/loading/error states for every new surface; keyboard + focus-visible paths; prefers-reduced-motion honored.\n` +
	`PRE-PROD POSTURE: schema changes are ADDITIVE on this branch (optional fields; old-MTA tolerance where the cards say so); clean breaking changes over back-compat ceremony elsewhere; no speculative seams; delete dead code your change orphans.`;

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
	`- Vue 3: composition API with <script setup>; props/emits typed; computed over methods for derived state; no reactivity leaks; watchers only where computed can't; template refs typed; v-for keys stable.\n` +
	`- Nuxt 4 (app/ dir): auto-import conventions (composables/utils placement); server routes under server/; navigateTo over router.push in setup; server/client guards for browser APIs; subdir components resolve as <DirName>Component.\n` +
	`- Convex: follow apps/api/convex/CONVENTIONS.md; queries use indexes, never .filter() over full scans; paginate anything unbounded; mutations idempotent where retried; no unbounded .collect(); Node actions ("use node") only where crypto/net requires them; scheduler/cron patterns match existing modules.\n` +
	`- Tailwind v4 / FF tokens: utilities over bespoke CSS; design tokens only (no raw hex/ms); dark/light both via tokens, never duplicated rules.\n` +
	`- TypeScript strict: discriminated unions over boolean flags; as-const/satisfies where they tighten types; no non-null assertions where a guard is honest; narrow at the boundary, not at every use site.\n` +
	`- Vitest: test behavior not implementation; convex-test for backend; deterministic (no real timers/network — mock fetch/DNS); table-driven where cases repeat; crypto tests use small fixed keys/fixtures so suites stay fast.\n` +
	`- Crypto/Email security: use the shared envelope primitives (createSecretBox / credentialCrypto) — NEVER hand-roll AES/HKDF calls outside them; distinct domain-separation info strings per use; constant-time comparisons for MACs/fingerprints where the stdlib offers them; webhook/manifest signature verification FAIL-CLOSED; suppression/reputation/report writes idempotent (redelivery happens); never log key material or message plaintext.\n`;

const REVIEWER_FOCUS =
	`0) HARD TEST GATE (check FIRST): the piece card names its test files under TESTS. The PR must ADD or EXTEND every named test surface. If any named test file/extension is missing, the verdict is request_changes REGARDLESS of code quality — say exactly which named tests are missing. Tests must be vitest (never bun test), deterministic, and must actually assert the card's claims (a file that exists but asserts nothing meaningful does NOT satisfy the gate).\n\n` +
	`1) SECURITY: Full-stack security for a Nuxt web app + Convex backend + Node MTA. ` +
	`Convex: every new/changed function uses the secure-by-default wrappers (authedQuery/authedMutation etc. per apps/api/convex/CONVENTIONS.md) with correct permission scope — NOTHING in e2ee/ may use authedIdentityMutation; org/user data isolation preserved on every new index/query; no direct process.env reads outside lib/env.ts (MTA-side env goes through apps/mta/src/config.ts). ` +
	`THIS PLAN'S HOT SPOTS: NO query/action path (public OR authed) may ever return private key material — look for it explicitly, including through spreads and .collect() returns; WKD/manifest/MTA-STS public routes expose PUBLIC material only and are host/path-disciplined; discovery fetches follow SSRF discipline (https only, public IPs only, no cross-host redirects, response size caps, timeouts); signature/verdict handling is FAIL-CLOSED (absent verdicts render "unknown", NEVER "pass"/"verified"; bad signature is stored unverified, never verified); sealed paths must not leak plaintext (canary-style assertions where the card asks); DKIM keys / relay creds / vault keys sealed at rest, never returned to clients; TOFU pinning transitions can't be downgraded silently (unsigned key change must surface, not auto-re-pin); TLS policy is strictest-wins and a 'require*' failure must NOT fall back to plaintext delivery. ` +
	`Web: no new v-html/innerHTML sinks; no secrets in client code; no new external network calls/trackers/CDN assets; URL/query params validated before use.\n\n` +
	`2) CODE QUALITY: The diff must CONFORM TO THE SHARED PRODUCT BRIEF (included in the PR body): locked decisions D1-D8 respected (flags default OFF on this branch, seal-only-when-all-recipients-have-keys, decrypt-on-ingest, no admin escrow); FF tokens only — zero hardcoded hex/shadow/duration; human copy; both themes. ` +
	`Strict TS (no new \`any\`, respect TS4111-style index-signature access); dead code deleted, not commented out; focused diff (no drive-by refactors outside the piece scope); bun.lock untouched unless the piece sanctions a dependency (only P0 does). ` +
	`Commits are small and ATOMIC (schema/backend, UI, tests, docs separated) with conventional messages, and carry NO AI/Claude attribution of any kind.\n\n` +
	`3) FUNCTIONALITY & TESTS: The piece genuinely delivers its spec and acceptance criteria; nothing that worked before is broken: existing send/receive pipelines (MTA sender, webhook dispatcher, mail/delivery ingest), Postbox read/draft/send, campaign sends (must stay PLAINTEXT and untouched per D5), delivery/readiness pages, DKIM signing and rotation. ` +
	`Behavior-neutral pieces (P0's createSecretBox extraction, E8a's accessor refactor) are provable by the EXISTING suites passing unmodified — verify the PR does not edit existing tests to make them pass. ` +
	`New Convex tables/modules are registered everywhere required — schema, api.d.ts hand-wiring (check-codegen), data export, backups/seed where applicable — a missing registration fails CI, so check \`gh pr checks\` before blaming logic. ` +
	`GitHub Actions is the source of truth for compile + test: check \`gh pr checks <num> --repo ${REPO}\`. BLOCK on FAILED checks; do NOT block solely because checks are pending/queued.\n\n` +
	`4) CODE SMELLS:\n${SMELLS}\n` +
	`5) BEST PRACTICES:\n${BEST_PRACTICES}`;

// ===========================================================================
// Shared conventions handed to every build / address / merge agent
// ===========================================================================
const CONV =
	`REPO ROOT: ${ROOT}\n` +
	`This is the public OSS monorepo ${REPO}. Remotes: \`origin\` = https://github.com/${REPO} (USE THIS), \`private\` = wolvessoftware/owlat (NEVER push here). ` +
	`BASE BRANCH FOR THIS PIPELINE: \`${BASE}\` — an integration branch cut from main. Worktrees branch from origin/${BASE}; PRs TARGET ${BASE}; the pipeline NEVER merges anything to ${MAIN} (the integration branch goes to ${MAIN} later as one giant human-merged PR).\n` +
	`Relevant surfaces: apps/mta (Node SMTP MTA — outbound sender = src/smtp/sender.ts + tlsRpt.ts + mtaSts.ts, inbound = src/inbound/{forwarder,router}.ts + src/bounce/, DKIM = src/lib/dkimStore.ts + dkimRotation.ts, env = src/config.ts, routes = src/routes/), apps/api/convex (backend — READ apps/api/convex/CONVENTIONS.md before adding/splitting files or touching mutation auth; env ONLY via lib/env.ts; crypto envelope = lib/credentialCrypto.ts; mail plane = mail/*, inbox plane = inbox/* + webhooks/dispatcher.ts; domains/DNS = domains/*; schema = schema/*), packages/shared (featureFlags.ts + pure cross-package modules), packages/email-scanner (content rules via registerContentRule; must stay content-only — no Convex imports), apps/web (Nuxt 4 — Postbox = app/components/postbox/* + app/pages/dashboard/postbox/*; delivery = app/pages/dashboard/delivery/*; server routes = server/; existing security badge = PostboxSecurityBadge.vue + @owlat/shared secureMessage classification), apps/docs (Nuxt Content docs; left-nav is a HARDCODED array in DocsSidebar.vue).\n\n` +
	`GOAL OF THIS PIPELINE: land the reviewed 2026-07-11 Sealed Mail plan on ${BASE} — transport hardening (TLS policy, MTA-STS publish, DANE, TLS-RPT dashboard, secrets at rest), sender authenticity (verdict persistence, honest badges, impersonation heuristics, ARC, alignment guard), and instance-to-instance E2EE (key vault + WKD + manifest, TOFU discovery, seal/open, trust surfaces, key lifecycle, two-instance proof, sealed at rest) — WITHOUT losing existing behavior.\n\n` +
	BRIEF +
	`\n\n` +
	`WORKTREE DISCIPLINE: do ALL file changes in a DEDICATED git worktree under ${SCRATCH} created from origin/${BASE}. NEVER switch branches or edit files in the user's main checkout at ${ROOT} (it must stay untouched — a convex dev watcher may be running there and rewrites api.d.ts). Use \`git -C "$WT"\` and edit files under "$WT". Pieces run in PARALLEL — never touch another piece's worktree or branch.\n\n` +
	`HARD RULES:\n` +
	`- VERIFICATION IS OFFLOADED TO GITHUB ACTIONS. Do NOT run \`bun run ci:verify\`, a full \`turbo lint/typecheck/test\`, a cold \`npx vitest\`, a \`nuxt build\`, or \`bun install\` + build chains inside the fresh worktree (no node_modules / cold builds exceed the ~180s no-progress watchdog and kill you; the ONE exception is P0's sanctioned lockfile regeneration). On push, GitHub Actions runs the full gate — that is the source of truth. Only INSTANT local checks are allowed: targeted \`grep\`/\`rg\`, reading files, a quick JSON/YAML parse, \`node -e\` one-liners. Give every Bash command a \`timeout\`.\n` +
	`- CI ENFORCES oxfmt FORMATTING. Before you push, format the files you changed: \`oxfmt --config "${ROOT}/oxfmtrc.json" --write <changed .ts/.js/.vue files>\` (run on the worktree copies; EXCLUDE any \`_generated/\` paths; NEVER run bare npx oxfmt without --config — it double-quotes files).\n` +
	`- NEW CONVEX TABLES (keyVault, recipientKeys, tlsReports): walk the full new-table registration checklist — schema domain file, indexes, any aggregate/data-export/backup/seed surfaces that enumerate tables (find how the newest existing table is registered and mirror it exactly). NEW CONVEX MODULES (e2ee/*, domains/tlsReports.ts): hand-wire _generated/api.d.ts — check-codegen fails otherwise; never let a convex watcher rewrite it.\n` +
	`- ENV DISCIPLINE: new Convex-side vars only via lib/env.ts (lint:env blocks direct process.env); MTA-side vars via apps/mta/src/config.ts; add every new var to .env.example/.env.selfhost.example with a comment.\n` +
	`- Tests are vitest, never \`bun test\`. THE TEST GATE IS HARD: implement every test file named on your piece card — the reviewer rejects the PR otherwise. Let CI run them.\n` +
	`- Do NOT weaken existing behavior: campaigns/transactional sends stay plaintext (D5); existing DMARC->Spam routing, DKIM rotation, and the "Encrypted - can't decrypt" path survive; every route and permission floor survives. Keep changes strictly within the piece's file scope.\n` +
	`- Commits: small and ATOMIC (one logical change each — schema/backend separate from UI, UI separate from tests/docs), conventional messages (feat:/refactor:/fix:/test:/docs:). ABSOLUTELY NO AI/Claude attribution — no "Co-Authored-By: Claude", no "Generated with", nothing identifying the commit as AI-authored.\n` +
	`- STAY IN SCOPE: work ONLY on this one piece and its branch/worktree. Do NOT read this workflow script, do NOT touch other pieces' branches, do NOT start other pieces.\n` +
	`- KEEP MOMENTUM: ~180-second no-progress watchdog per step. Prefer ripgrep + targeted Reads (offset/limit) over reading whole large files; act incrementally with frequent tool calls. Some source files contain em-dash bytes that make grep treat them as binary — use \`grep -a\` if a text search unexpectedly finds nothing.\n` +
	`- STRICT TypeScript is the #1 CI failure cause — write type-correct code the FIRST time. This repo runs tsconfig strict + noUncheckedIndexedAccess + noPropertyAccessFromIndexSignature. Concretely: (a) index-signature / dynamic-key access MUST use bracket notation and be narrowed — \`obj['key']\` not \`obj.key\` when the type is a Record/index signature (the TS4111 trap); (b) any array/Map/object lookup can be \`undefined\` — guard it before use; (c) NO new \`any\` (use \`unknown\` + narrowing or a real type); (d) remove EVERY unused import/var/param (oxlint fails on these); (e) exhaustive switch/discriminated unions need a default or never-check; (f) Nuxt subdir component auto-import resolves as <DirName><File> — an unresolved tag renders NOTHING silently, so verify tag names. Convex: new functions go through the secure-by-default wrappers and every new table/module must be reachable from api.d.ts.\n`;

// ===========================================================================
// LOCAL PREFLIGHT — cheap, watchdog-SAFE checks that catch most CI failures
// WITHOUT a cold build.
// ===========================================================================
const PREFLIGHT =
	`LOCAL PREFLIGHT (run in the worktree BEFORE you push — these are fast and watchdog-safe; give each a \`timeout\`):\n` +
	`1. FORMAT: \`oxfmt --config "${ROOT}/oxfmtrc.json" --write <your changed .ts/.js/.vue files>\` (exclude any _generated/ paths). Instant.\n` +
	`2. LINT (catches unused vars/imports, no-explicit-any, and many correctness lints; needs NO types or build): \`oxlint --config "${ROOT}/oxlintrc.json" <changed dirs/files>\`. Read EVERY reported problem and fix it (hand-fix; \`--fix\` only for the safe auto-fixable ones). Re-run until zero errors on your files.\n` +
	`3. FAST REPO LINTS (pure file/grep checks, no build — run only if you touched files they cover): file-size ratchet \`bash "${ROOT}/scripts/check-file-size.sh"\`, branding \`bash "${ROOT}/scripts/check-branding.sh"\`, cross-package imports \`bash "${ROOT}/scripts/check-cross-package-imports.sh"\`, env discipline \`bash "${ROOT}/scripts/check-env-vars.sh" 2>/dev/null || true\`. Fix anything they flag. (Do NOT run scripts/check-format.sh — it breaks on macOS bash 3.2; oxfmt --check is the equivalent.)\n` +
	`4. TYPES — reason, do not cold-build: you CANNOT run \`turbo typecheck\`/\`nuxt typecheck\`/\`tsc\` here (needs a warm install + generated types; it will exceed the watchdog and kill you). Instead SELF-REVIEW every changed .ts/.vue against the STRICT TypeScript rules in HARD RULES above — read your own diff adversarially for undefined-index access, index-signature dot access, unused symbols, and new \`any\`. GitHub Actions runs the real typecheck.\n` +
	`Only push once preflight steps 1-3 are clean and you have self-reviewed types. This turns first-push-red into first-push-green and saves a whole CI+fix round.\n`;

// ===========================================================================
// PIECES — one atomic PR each, targeting the integration branch. WAVES are
// explicit (hand-balanced for disjoint files per the plan manifest); a wave is
// an array of TRACKS; tracks run in parallel, pieces inside a track serially.
// Specs come from the reviewed 2026-07-11 implementation plan
// (sealed-mail-implementation.html, artifact 2499abf2).
// ===========================================================================
const PIECES = [
	// ---- Wave 0: scaffolding -------------------------------------------------
	{
		id: 'p0-scaffolding',
		kind: 'feat',
		group: 'scaffolding',
		dependsOn: [],
		wave: 0,
		branch: 'sm/p0-scaffolding',
		title:
			'feat: sealed-mail scaffolding — CI triggers for integration/*, openpgp dep, flags, createSecretBox, fixture corpus',
		spec:
			'STEP A — CI TRIGGER FIX, DO THIS FIRST (hard blocker for the whole pipeline): .github/workflows/test.yml and .github/workflows/desktop-ci.yml filter pull_request to branches [main, stage, pro] — PRs targeting integration/* get NO CI today. Add "integration/**" to the pull_request branches list in BOTH files, and to test.yml\'s push branches list too (so the integration head re-verifies after each squash-merge). For pull_request events GitHub reads the workflow file from the PR merge commit, so THIS PR itself should get a full CI run once pushed — verify with `gh pr checks` that checks appear within ~3 minutes of pushing. IF NO CHECKS APPEAR: escalate — create a separate branch off origin/main containing ONLY the two workflow-filter edits, push it, open a PR to main titled "ci: run PR checks for integration/** base branches", squash-merge it yourself via `gh pr merge --squash` (explicitly authorized for this one CI-config PR), then bring the fix into the integration branch: merge origin/main into integration/sealed-mail in a scratch worktree and push it, rebase your branch on the updated integration branch, and close+reopen your PR to retrigger checks. ' +
			"STEP B — the scaffolding itself: (1) Add the `openpgp` package to apps/api (it will be used from Node actions) and regenerate bun.lock IN THE SAME COMMIT — a stale lockfile is a frozen-lockfile CI insta-fail. Sanctioned lockfile command: `timeout 420 bun install --lockfile-only` at the worktree root (if --lockfile-only is unsupported, run plain `timeout 420 bun install` — this is the pipeline's ONE sanctioned install). " +
			'(2) Feature flags `senderAuthBadges` and `sealedMail` in packages/shared/src/featureFlags.ts following the existing flag-gate pattern (mirror how the newest flag, e.g. the AI-providers or chat flag, is declared and gated) — BOTH DEFAULT OFF. ' +
			'(3) Extract the AES-256-GCM + HKDF envelope construction inside apps/api/convex/lib/credentialCrypto.ts into a reusable exported core `createSecretBox(secret, saltInfo)` IN THE SAME FILE, so the MTA (T6) and keyVault (E1) later reuse identical primitives with distinct domain-separation strings. ZERO behavior change for existing envelopes — the existing credentialCrypto tests must pass UNMODIFIED. ' +
			'(4) Create the interop fixture corpus at apps/api/fixtures/sealed-mail/ with a README.md documenting exactly how each fixture was/should be generated (the gpg commands, ARC chain source, TLS-RPT sample origin) and check in the initial corpus as bytes: PGP/MIME messages (good sig / bad sig / no sig / protected headers variant), an ARC chain set (valid rescue / broken AMS / untrusted sealer / cv=fail), a gzipped RFC 8460 TLS-RPT report, WKD z-base32/SHA-1 hash test vectors, DNS answer mocks (TLSA, _mta-sts TXT). Generate PGP fixtures with `gpg` if `which gpg` finds it; otherwise generate them with a small one-off node script using the freshly added openpgp package (document in the README that GnuPG-regenerated versions are a QA follow-up) — either way CI must never need gpg installed. ' +
			'(5) Commit this pipeline\'s harness into the repo: copy "' +
			ROOT +
			'/.claude/workflows/sealed-mail-prs.js" from the MAIN CHECKOUT (read-only copy — do not edit the main checkout) into the worktree at .claude/workflows/sealed-mail-prs.js and commit it as its own docs/chore commit.',
		tests:
			'NAMED TEST GATE: (a) apps/api/convex/lib/__tests__/credentialCrypto.test.ts — existing suite green UNMODIFIED plus new createSecretBox tests: round-trip, tamper detection (auth-tag flip fails), cross-info-string isolation (box sealed with info A does not open with info B); (b) the feature-flags module test asserts senderAuthBadges + sealedMail exist and default OFF; (c) CI proof = this PR itself runs the full Actions matrix (that IS the no-op-PR proof from the plan).',
	},

	// ---- Wave 1: transport floor + verdict plumbing ---------------------------
	{
		id: 't1-tls-policy',
		kind: 'feat',
		group: 'transport',
		dependsOn: ['p0-scaffolding'],
		wave: 1,
		branch: 'sm/t1-tls-policy',
		title: 'feat(mta): outbound TLS policy switch + relay TLS floor',
		spec:
			'New PURE module apps/mta/src/smtp/tlsPolicy.ts: resolveTlsRequirements({ localMode, stsPolicy, daneResult }) -> { requireTLS, rejectUnauthorized, reason }. Strictest-wins semantics; daneResult is plumbed through the signature but always null until T3 lands (no dead branches beyond accepting the param). ' +
			'New env OUTBOUND_TLS_MODE (values: opportunistic | require | require-verified, default opportunistic) declared in apps/mta/src/config.ts; per-domain overrides stored in a Redis hash managed via a new authed MTA route (mirror the apps/mta/src/routes/dkim.ts pattern for auth + shape). ' +
			'apps/mta/src/smtp/sender.ts attemptSend(): call the resolver instead of inlining MTA-STS logic; a failed handshake under require/require-verified => permanent-ish retry classification + the correct TLS-RPT result type recorded. ' +
			'Relay adapter apps/api/convex/lib/sendProviders/smtp/index.ts: add tls: { minVersion: "TLSv1.2" } to the transport options (the pin exists elsewhere but is missing here). ' +
			'UI: outbound-TLS mode selector in the TransportEditor.vue with honest bounce-risk copy ("require-verified can bounce mail to misconfigured receivers"); env write via the existing apply-transport route. ' +
			'ACCEPTANCE: default behavior byte-identical to today (opportunistic + STS); the switch provably changes handshake demands.',
		tests:
			'NAMED TEST GATE: (a) NEW apps/mta/src/smtp/__tests__/tlsPolicy.test.ts — the full 3x3 (mode x STS state) matrix including reason strings; (b) EXTEND the existing outboundStartTls.test.ts / outboundTls.test.ts suites — require-verified vs a broken-TLS receiver => bounce + certificate-not-trusted / starttls-not-supported recorded in TLS-RPT; (c) NEW adapter test asserting the relay transport options include the minVersion pin and requireTLS still set; (d) EXTEND apps/web/app/composables/__tests__/transportEditor.test.ts for the new field.',
	},
	{
		id: 't6-secrets-at-rest',
		kind: 'feat',
		group: 'transport',
		dependsOn: ['p0-scaffolding'],
		wave: 1,
		branch: 'sm/t6-secrets-at-rest',
		title: 'feat(mta): seal DKIM keys + relay credentials at rest',
		spec:
			'New apps/mta/src/lib/secretBox.ts using the P0 createSecretBox construction (same envelope; MTA-local implementation may mirror the primitive if importing across packages is not sanctioned — check package boundaries first and follow check-cross-package-imports), keyed by new env MTA_SECRET (declared in apps/mta/src/config.ts; boot-validated: >= 32 bytes; the installer/quickstart generates it — update apps/setup-cli + install.sh env generation accordingly and add to .env examples). ' +
			'apps/mta/src/lib/dkimStore.ts: seal private-key values on write, unseal on read; LAZY BOOT MIGRATION — plaintext Redis entries detected on read => sealed in place, logged once; dkimRotation.ts stays semantically untouched. ' +
			'Relay password: the apply-transport route (apps/web server/api apply-transport.post.ts) writes the SMTP relay password to the encrypted env store instead of plaintext; the MTA/API read path unseals. ' +
			'ACCEPTANCE: a redis-cli dump contains no PEM markers; DKIM signatures verify unchanged before/after migration.',
		tests:
			'NAMED TEST GATE: (a) NEW apps/mta/src/lib/__tests__/secretBox.test.ts — round-trip, tamper, wrong-key failure; (b) EXTEND the dkimStore tests — sealed round-trip + the migration case (seed plaintext -> boot/read -> sealed in place, signer output byte-identical before/after); (c) the existing dkimRotation suite green UNMODIFIED.',
	},
	{
		id: 'a1-auth-verdicts',
		kind: 'feat',
		group: 'authenticity',
		dependsOn: ['p0-scaffolding'],
		wave: 1,
		branch: 'sm/a1-auth-verdicts',
		title: 'feat: persist SPF/DKIM/DMARC verdicts on BOTH inbound paths',
		spec:
			'The MTA computes full SPF/DKIM/DMARC but webhooks/dispatcher.ts DROPS the verdicts on the AI-inbox path (mailMessages has them, inboundMessages does not) — fix that. ' +
			'apps/mta/src/inbound/forwarder.ts + its types.ts: add alignment domains (envelopeFromDomain, dkimSigningDomain) beside the existing verdicts in the webhook payload. ' +
			'apps/api/convex/schema/inbox.ts (inboundMessages): add spfResult / dkimResult / dmarcResult / dmarcPolicy; apps/api/convex/schema/mail.ts (mailMessages): add the two alignment-domain fields; ALL new fields optional. ' +
			'webhooks/dispatcher.ts inbound.received handler + inbox/messages.ts receiveMessage: stop dropping, persist the verdicts. mail/webhook.ts + mail/delivery.ts: persist the new alignment fields. ' +
			'OLD-MTA TOLERANCE: all fields optional; absent => stored absent (renders later as "unknown", NEVER as "pass"). ' +
			'ACCEPTANCE: the same webhook fixture yields identical verdict rows in inboundMessages and mailMessages.',
		tests:
			'NAMED TEST GATE: (a) EXTEND apps/mta/src/inbound/__tests__/forwarder.test.ts — payload includes verdicts + alignment domains; (b) NEW convex-test apps/api/convex/inbox/__tests__/receiveMessageAuth.test.ts and apps/api/convex/mail/__tests__/ingestAuthVerdicts.test.ts — verdicts persisted on both paths; the absent-verdict case stored as absent.',
	},
	{
		id: 'a2-reader-verdicts',
		kind: 'feat',
		group: 'authenticity',
		dependsOn: ['a1-auth-verdicts'],
		wave: 1,
		branch: 'sm/a2-reader-verdicts',
		title: 'feat(api): thread auth verdicts into the reader queries',
		spec:
			'Extend the mail queries feeding PostboxThreadReader.vue (and the AI-inbox message queries) with all four verdicts + the alignment domains; widen the PostboxReaderMessage type accordingly. NO UI change yet — A3 consumes these fields next wave. Legacy rows (fields absent) must surface as absent, not defaulted. ' +
			'ACCEPTANCE: type-clean (CI nuxt typecheck green); zero visual diff.',
		tests:
			'NAMED TEST GATE: NEW convex-test apps/api/convex/mail/__tests__/threadReaderAuth.test.ts — the reader query returns the six fields for a seeded message and absent for legacy rows.',
	},

	// ---- Wave 2: publish + dashboards + badge --------------------------------
	{
		id: 't2-mta-sts-publish',
		kind: 'feat',
		group: 'transport',
		dependsOn: ['p0-scaffolding'],
		wave: 2,
		branch: 'sm/t2-mta-sts-publish',
		title: 'feat: publish our own MTA-STS policy',
		spec:
			"Today Owlat only ENFORCES other domains' MTA-STS; this piece publishes our own. " +
			'Pure serializer packages/shared/src/mtaStsPolicy.ts: (org mode + MX set, sourced from getInboundMailConfig) -> RFC 8461 policy body; policy id = short hash of (mode, MX set) so it changes iff mode/MX change. ' +
			'Nuxt server route, HOST-MATCHED on mta-sts.<domain>, serving /.well-known/mta-sts.txt with the correct text/plain content type; 404 off-host. ' +
			'Org setting mtaStsMode (none | testing | enforce) with a none->testing->enforce stepper UI on the delivery page; _mta-sts TXT + mta-sts CNAME rows added to ReceivingDnsSection.vue via the existing RecordRow plumbing. ' +
			'domains/dnsVerification.ts: gather + verify the record AND the served policy (id match); delivery-readiness input extended (enforce without the record => warn).',
		tests:
			'NAMED TEST GATE: (a) NEW packages/shared serializer tests — exact RFC 8461 body per mode; id changes iff MX/mode change; (b) NEW Nuxt server-route test — correct content-type, 404 off-host; (c) EXTEND convex-test dnsVerification gather + deliveryReadiness.test.ts (enforce without record => warn).',
	},
	{
		id: 't4-tls-rpt-dashboard',
		kind: 'feat',
		group: 'transport',
		dependsOn: ['p0-scaffolding'],
		wave: 2,
		branch: 'sm/t4-tls-rpt-dashboard',
		title: 'feat: TLS-RPT inbound ingestion + delivery-page dashboard',
		spec:
			'We publish a TLS-RPT rua today but ingest nothing — close the loop. ' +
			'Register the rua mailto address as a SYSTEM inbound route in apps/mta/src/inbound/router.ts delivering to a dedicated webhook event (not a user mailbox). ' +
			'New apps/api/convex/domains/tlsReports.ts: gunzip + zod-parse RFC 8460 JSON, upsert IDEMPOTENTLY by report-id into a new tlsReports table (walk the FULL new-table registration checklist; hand-wire api.d.ts for the new module), aggregation query (per-partner success rate, failure-type counts, 30-day trend). Malformed/oversized reports rejected without throwing. ' +
			'Delivery-page card rendering the aggregation with plain-language failure-type explanations ("STARTTLS stripped upstream", "certificate mismatch").',
		tests:
			'NAMED TEST GATE: (a) SYMMETRIC ROUND-TRIP test — feed the output of our own outbound generator (apps/mta/src/smtp/tlsRpt.ts) into the new parser, full fidelity; (b) convex-test — fixture ingest of the real-world sample from fixtures/sealed-mail/, malformed/oversized rejected without throwing, duplicate report-id idempotent; (c) aggregation query test + dashboard card component test.',
	},
	{
		id: 'a3-auth-badge',
		kind: 'feat',
		group: 'authenticity',
		dependsOn: ['a2-reader-verdicts'],
		wave: 2,
		branch: 'sm/a3-auth-badge',
		title: 'feat(web): sender-authentication badge + reply guard (flag senderAuthBadges)',
		spec:
			'FLAG-GATED behind senderAuthBadges (default OFF on this branch). ' +
			'Pure derivation apps/web/app/utils/senderAuth.ts: (verdicts + alignment domains) -> { state: "verified" | "unauthenticated" | "misaligned" | "failed", detail } with a copy table, including the VERBATIM string "Sent by {actualDomain}, which is not authorized to send for {fromDomain}." for the misaligned state. Legacy rows (all verdicts absent) => NO badge, never "verified" — fail-closed honesty. ' +
			'PostboxAuthBadge.vue modeled on PostboxSecurityBadge.vue (quiet when verified, expandable detail); mounted in the sender header block of PostboxThreadReader.vue, REPLACING the ad-hoc DMARC banner there. ' +
			'Reply guard: an interstitial confirm on reply/reply-all to a "failed" message, shown once per thread; existing DMARC->Spam routing untouched. ' +
			'ACCEPTANCE (honesty audit): every reachable badge string maps 1:1 to a checked condition — enforced by the derivation unit test.',
		tests:
			'NAMED TEST GATE: (a) NEW apps/web/app/utils/__tests__/senderAuth.test.ts — six fixtures: aligned pass / no auth / unaligned pass / fail+p=none / fail+p=reject / legacy row (all absent => no badge); (b) NEW apps/web postbox component test PostboxAuthBadge.test.ts — VERBATIM copy per state, expand/collapse, flag-off renders nothing; (c) reply-guard component test — interstitial shown once per thread, reply proceeds on confirm.',
	},
	{
		id: 'a4-impersonation',
		kind: 'feat',
		group: 'authenticity',
		dependsOn: ['a1-auth-verdicts'],
		wave: 2,
		branch: 'sm/a4-impersonation',
		title: 'feat: sender-impersonation heuristics (scanner rule + ingest-side flags)',
		spec:
			'packages/email-scanner/src/content/senderImpersonation.ts registered via registerContentRule: punycode/homoglyph From-domain detection (REUSE the existing homoglyphs.ts), Reply-To domain != From domain; new ContentFlagType values following the existing enum pattern. THE SCANNER PACKAGE STAYS CONTENT-ONLY — no Convex imports; the registry boundary must hold. ' +
			"Ingest-side heuristics (need data the scanner cannot see), computed in apps/api/convex/mail/delivery.ts / the agent security_scan step and stored in the EXISTING flag plumbing: first-time-sender flag (no prior thread with the address) and lookalike-of-known-contact (bounded edit-distance against the org's contact domains, e.g. paypa1.com vs a contact at paypal.com). " +
			"Surfaces through A3's badge detail section as secondary lines (NOT a second badge) — if A3 has not merged yet when you build, land the data + derivation and extend the badge fixture in a way that composes (check what is on the integration branch first).",
		tests:
			'NAMED TEST GATE: (a) NEW packages/email-scanner .../__tests__/senderImpersonation.test.ts — punycode, mixed-script homoglyph, reply-to mismatch, clean negatives (NO false positive on subdomains of the same org); (b) convex-test — first-time-sender true/false, lookalike hit persisted via the flag plumbing; (c) badge component fixture extended for the heuristic lines (coordinate with whatever A3 state exists on the branch).',
	},

	// ---- Wave 3: DANE + ARC + alignment + E2EE foundations --------------------
	{
		id: 't3-dane',
		kind: 'feat',
		group: 'transport',
		dependsOn: ['t1-tls-policy'],
		wave: 3,
		branch: 'sm/t3-dane',
		title: 'feat(mta): DANE at send time (flag DANE_ENABLED)',
		spec:
			'FLAG-GATED behind DANE_ENABLED env (default off; flag off => byte-identical to T1 behavior). ' +
			'Promote the TLSA parse/match logic that lives in apps/api/convex/domains/dnsVerification.ts (own-domain checks) into packages/shared/src/dane.ts so both callers converge on one implementation. ' +
			'New apps/mta/src/smtp/daneResolver.ts: TLSA lookup per MX via the configured resolver (DANE_RESOLVER_URL, DoH; AD bit REQUIRED — AD absent => treated as "no TLSA", per locked decision D6); cache respecting DNS TTLs. ' +
			'tlsPolicy.ts: daneResult now real; precedence DANE > MTA-STS; usage 2/3 (DANE-TA/DANE-EE) certificate matching in sender.ts per RFC 7672. ' +
			'tlsRpt.ts: emit the reserved "tlsa" policy type + validation-failure results. Document the local-validating-resolver production recommendation where MTA config is documented.',
		tests:
			'NAMED TEST GATE: (a) NEW packages/shared dane tests — RFC 6698 test vectors (usage/selector/matching-type grid) against fixture certs; (b) NEW daneResolver tests — AD=1 secure answer enforced, AD=0 ignored, NXDOMAIN falls through; (c) EXTEND the sender matrix — TLSA match => verified TLS required; mismatch => bounce + TLS-RPT validation-failure with tlsa policy; flag off => byte-identical to T1; (d) EXTEND tlsPolicy.test.ts precedence rows (DANE beats STS-none and STS-testing; agrees with STS-enforce).',
	},
	{
		id: 'a5-arc',
		kind: 'feat',
		group: 'authenticity',
		dependsOn: ['a1-auth-verdicts'],
		wave: 3,
		branch: 'sm/a5-arc',
		title: 'feat: inbound ARC verification with trusted-forwarder overrides',
		spec:
			'apps/mta/src/bounce/inboundArc.ts: verify the AAR/AMS/AS chain via the mailauth package — BEHIND A THIN LOCAL INTERFACE verifyArcChain(raw): ArcVerdict, so a future packages/mail-auth implementation can swap in without touching callers (the own-the-inbound plan explicitly defers ARC to this piece). ' +
			'Trusted-forwarder list in instance settings (seeded defaults: major mailing-list/forwarding providers), editable in the delivery settings UI. ' +
			'apps/api/convex/mail/delivery.ts: DMARC fail + valid chain from a TRUSTED sealer attesting the original passed => skip spam-routing, store dmarcOverride: "arc"; the A3 badge renders a "verified via forwarder" state. ' +
			'ACCEPTANCE: a real mailing-list message (fixture from an actual list) stops false-failing; closes backlog item 3.6.',
		tests:
			'NAMED TEST GATE: (a) NEW inboundArc.test.ts over fixtures/sealed-mail/arc/ — valid rescue chain, broken AMS, untrusted sealer, cv=fail; (b) convex-test — override stored + spam-routing skipped ONLY for trusted sealers; settings gating; (c) badge fixture — the "verified via forwarder" state copy.',
	},
	{
		id: 'a6-alignment-guard',
		kind: 'feat',
		group: 'authenticity',
		dependsOn: ['p0-scaffolding'],
		wave: 3,
		branch: 'sm/a6-alignment-guard',
		title: 'feat: outbound DMARC-alignment guard in delivery readiness + From pickers',
		spec:
			"apps/api/convex/deliveryReadiness.ts (or its current module location — find it): new alignment gate comparing the transport's effective DKIM d= / return-path domain vs the org's From domains; a relay transport with a foreign d= => warn with per-transport guidance. Alignment helpers already exist in domains/spf.ts / domains/dmarc.ts — reuse them. " +
			'campaigns/senders.ts listForPicker: annotate each identity with domain verification + alignment state; the From-pickers (campaign wizard + Postbox composer) render the chip and disable-with-reason for broken identities. ' +
			'ACCEPTANCE: a misaligned relay setup shows the warning on the delivery page AND in the From picker before any send.',
		tests:
			'NAMED TEST GATE: (a) EXTEND deliveryReadiness.test.ts — relay-misaligned warn, mta-aligned pass, ses cases; (b) convex-test picker annotation; (c) component test for the chip + disabled-with-reason state.',
	},
	{
		id: 'e1-key-vault',
		kind: 'feat',
		group: 'e2ee',
		dependsOn: ['p0-scaffolding'],
		wave: 3,
		branch: 'sm/e1-key-vault',
		title:
			'feat(api): E2EE key vault + WKD publication + signed instance manifest (flag sealedMail)',
		spec:
			'FLAG-GATED behind sealedMail (default OFF). New domain folder apps/api/convex/e2ee/ (keys.ts, wkd.ts, manifest.ts) + new schema/e2ee.ts with the keyVault table — walk the FULL new-table registration checklist AND hand-wire _generated/api.d.ts for the new module (check-codegen gotcha). NOTHING in e2ee/ may use authedIdentityMutation. ' +
			'Keygen: Ed25519 primary + X25519 encryption subkey via openpgp.js in a Node action; the private key sealed with createSecretBox(INSTANCE_SECRET, "owlat:e2ee:keys:v1"); keys minted on mailbox/alias creation (hooks in mail/aliases.ts + mail/identities.ts) + an IDEMPOTENT backfill mutation for existing addresses; an instance identity keypair minted at first boot. ' +
			'WKD: Nuxt server routes for /.well-known/openpgpkey/policy and /.well-known/openpgpkey/hu/<zbase32(sha1(localpart))> (direct method), binary key body served from a Convex query that exposes PUBLIC key material ONLY. ' +
			'Manifest: /.well-known/owlat.json — instance pubkey, features (e2ee: 1), key-directory digest, rotation-feed URL — SIGNED by the instance key. ' +
			'Readiness: an "encryption keys published" check in dnsVerification.ts / delivery readiness (fetches own WKD + manifest). ' +
			"ACCEPTANCE: Thunderbird can discover a staging address's key via WKD with zero Owlat-specific setup (manual QA later; the route/format tests are the CI proxy).",
		tests:
			'NAMED TEST GATE: (a) NEW apps/api/convex/e2ee/__tests__/keys.test.ts — idempotent mint, envelope round-trip, AUTHZ NEGATIVE TEST: no public query/action path returns private material, backfill covers all aliases; (b) NEW wkd.test.ts — z-base32/SHA-1 hash vectors from the WKD spec (use the P0 fixture vectors), armored<->binary export; (c) NEW manifest.test.ts — signature verifies against the served pubkey, digest matches directory contents; (d) Nuxt route tests — content-types, unknown local-part => 404.',
	},
	{
		id: 'e8a-message-body-accessor',
		kind: 'refactor',
		group: 'e2ee',
		dependsOn: ['p0-scaffolding'],
		wave: 3,
		branch: 'sm/e8a-message-body-accessor',
		title: 'refactor(api): getMessageBody() accessor over all message-body reads + CI ratchet',
		spec:
			'BEHAVIOR-NEUTRAL refactor — the correctness proof is the ENTIRE existing api suite passing UNMODIFIED. ' +
			'New apps/api/convex/lib/messageBody.ts: ONE accessor covering the three storage shapes — inboundMessages inline bodies, mailMessages storage blobs + inline snippets, unifiedMessages.content JSON. ' +
			'Migrate the ~30 direct readers (agent steps, knowledge extraction, mail AI / needs-reply / voice-profile, timeline/export, preview builder — grep exhaustively for textBody/htmlBody/body-blob reads) onto it. Mechanical, zero behavior change. ' +
			'New CI ratchet script check-body-access (grep-based, modeled on the existing authz/boolean-naming ratchet scripts in scripts/): direct textBody/htmlBody/body-blob reads outside messageBody.ts fail the build; BASELINE 0 from day one; wire it into `bun run lint` the same way the sibling ratchets are wired.',
		tests:
			'NAMED TEST GATE: (a) NEW apps/api/convex/lib/__tests__/messageBody.test.ts — parity across all three shapes incl. blob-only, inline-only, legacy rows; (b) ratchet script self-test (a fixture file with a violation fails it); (c) the ENTIRE existing api suite green UNMODIFIED (do not edit existing tests).',
	},

	// ---- Wave 4: discovery -> sealing (serial track) ---------------------------
	{
		id: 'e2-discovery-tofu',
		kind: 'feat',
		group: 'e2ee',
		dependsOn: ['e1-key-vault'],
		wave: 4,
		branch: 'sm/e2-discovery-tofu',
		title: 'feat(api): recipient key discovery + TOFU pinning',
		spec:
			"apps/api/convex/e2ee/discovery.ts action: manifest fetch -> WKD fetch per address; SSRF DISCIPLINE THROUGHOUT (https only, public IPs only, no cross-host redirects, response size cap, timeouts — copy the MTA-STS fetcher's hardening); results into a new recipientKeys table (FULL new-table checklist + api.d.ts) with 24h TTL and 1h negative cache; a scheduled refresh cron following existing cron patterns. Key<->address binding validated (the fetched key must certify the address's UID). " +
			'Pure apps/api/convex/e2ee/pinning.ts: first-use pin; a SIGNED rotation statement (old key signs the new fingerprint, delivered via the manifest rotation feed) => silent upgrade; an UNSIGNED key change => keyChanged state (never silently re-pin); explicit re-accept transition.',
		tests:
			'NAMED TEST GATE: (a) NEW discovery.test.ts (mocked fetch) — manifest hit, WKD-only fallback, negative cache honored, TTL refresh, key<->address binding validated; (b) SSRF negatives — redirect to 10.x / 169.254.x / localhost rejected; plain http rejected; oversized body rejected; (c) NEW pinning.test.ts — the FULL state machine: pin / signed-rotate / unsigned-change / re-accept transitions.',
	},
	{
		id: 'e3-outbound-sealing',
		kind: 'feat',
		group: 'e2ee',
		dependsOn: ['e2-discovery-tofu'],
		wave: 4,
		branch: 'sm/e3-outbound-sealing',
		title: 'feat(api): outbound sealing — PGP/MIME with protected headers (flag sealedMail)',
		spec:
			'apps/api/convex/e2ee/seal.ts: sealMime(rawRfc822, { recipientKeys, signingKey, protectSubject }) -> PGP/MIME with protected headers (real subject inside; outer subject the literal "..." placeholder), sign+encrypt via openpgp.js. ' +
			'apps/api/convex/mail/outbound.ts: after the RFC822 build — org policy allows AND every recipient has a usable PINNED key => seal; the stored .eml is the SEALED bytes; encryptionInfo recorded on the outbound record. One keyless recipient => plaintext send + reason recorded (NEVER a mixed send, per D2). MTA/mail-sync call sites unchanged — ciphertext is just a message body to them. ' +
			'apps/api/convex/mail/draftLifecycle.ts: expose per-draft sealState (willSeal | cannotSeal(reason) | keyChanged) for the composer — consumed by E5 next wave; the agent-reply path flows through the same sealing path untouched. ' +
			'ACCEPTANCE: the no-plaintext-canary assertion — a unique marker string in the body is absent from everything that leaves outbound.ts when sealing applies.',
		tests:
			'NAMED TEST GATE: (a) NEW seal.test.ts — output classified by classifySecureMessage as PGP/MIME; decrypts + signature verifies with openpgp; protected subject inside, "..." outside; attachments survive; (b) CROSS-CHECK FIXTURE: our sealed output decrypted by GnuPG once offline, recorded, committed to fixtures/sealed-mail/ — regression-compared structurally (if gpg is unavailable locally, verify with openpgp.js and document GnuPG re-verification in the fixture README as QA follow-up); (c) convex-test outbound — all-recipients rule (1 keyless recipient => plaintext + reason recorded), policy off => never seals, STORED .EML BYTES CONTAIN NO PLAINTEXT CANARY STRING, agent-reply path seals; (d) draftLifecycle sealState tests for all three states.',
	},

	// ---- Wave 5: unsealing -> trust surfaces (serial track) --------------------
	{
		id: 'e4-inbound-unsealing',
		kind: 'feat',
		group: 'e2ee',
		dependsOn: ['e1-key-vault', 'e8a-message-body-accessor'],
		wave: 5,
		branch: 'sm/e4-inbound-unsealing',
		title: 'feat(api): inbound unsealing + signature verification (decrypt-on-ingest)',
		spec:
			"apps/api/convex/e2ee/open.ts: detect PGP/MIME -> decrypt with the recipient's vault key -> verify the signature against the discovered/pinned sender key -> restore protected headers. " +
			'apps/api/convex/mail/delivery.ts ingest: DECRYPT-ON-INGEST (D3) — plaintext bodies flow into the normal pipeline (categorize, needs-reply, agent, knowledge all keep working); the sealed original retained as rawStorageId; encryptionInfo { sealed, cipherSuite, signatureValid, signerFingerprint, signerInstance } persisted (schema fields on mailMessages + a mirrored flag on inboundMessages). ' +
			'FAILURE HONESTY: undecryptable => today\'s "Encrypted - can\'t decrypt" path untouched (sealed original downloadable); decrypts-but-bad-signature => stored as UNVERIFIED, never verified. ' +
			'ACCEPTANCE: round-trip with E3 in one test — seal on "instance A" fixture keys, open via ingest, byte-equal body.',
		tests:
			"NAMED TEST GATE: (a) convex-test ingest matrix — sealed+goodSig => plaintext stored + original retained + encryptionInfo correct; badSig => signatureValid false; unknown key => can't-decrypt path intact; plaintext message => untouched fast path; (b) INTEROP FIXTURES — the GnuPG- and Thunderbird-generated messages from fixtures/sealed-mail/ (encrypted to our published test key) open correctly, protected headers restored; (c) MIRROR TEST — unifiedMessages mirror contains decrypted text and the agent pipeline consumes it (one end-to-end convex-test through receiveMessage).",
	},
	{
		id: 'e5-trust-surfaces',
		kind: 'feat',
		group: 'e2ee',
		dependsOn: ['e3-outbound-sealing', 'e4-inbound-unsealing', 'a3-auth-badge'],
		wave: 5,
		branch: 'sm/e5-trust-surfaces',
		title: 'feat(web): trust surfaces — composer lock, sealed badges, key-change banner',
		spec:
			'Composer lock with the three states from draftLifecycle.sealState (willSeal / cannotSeal(reason) / keyChanged) and reason copy; send-anyway is an EXPLICIT act for cannotSeal. ' +
			'PostboxSecurityBadge.vue extended: "Sealed - sender verified" / "Sealed - sender not verified" / the existing can\'t-decrypt state — driven by encryptionInfo. ' +
			'Key-change thread banner (Signal-style, explicit accept -> re-pin via the E2 mutation); org policy setting (auto / ask / off) in settings; per-contact key panel (fingerprint, first seen, history). ' +
			'ACCEPTANCE (honesty audit): "Sealed - sender verified" is UNREACHABLE in tests without signatureValid && pinMatch — enforced by the derivation unit test.',
		tests:
			'NAMED TEST GATE: (a) component tests — three composer lock states with VERBATIM copy; badge states VERBATIM (the honesty-audit assertions); key-change banner accept flow calls the re-pin mutation; (b) convex-test — org policy "off" provably prevents sealing, asserted at the OUTBOUND layer, not just UI.',
	},

	// ---- Wave 6: lifecycle + proof + at-rest ----------------------------------
	{
		id: 'e6-key-lifecycle',
		kind: 'feat',
		group: 'e2ee',
		dependsOn: ['e2-discovery-tofu', 'e4-inbound-unsealing'],
		wave: 6,
		branch: 'sm/e6-key-lifecycle',
		title: 'feat(api): key lifecycle — rotation, revocation, recovery kit',
		spec:
			'Rotation: mint a new key, publish the SIGNED rotation statement to the manifest rotation feed, keep the old key DECRYPT-ONLY (mirrors the DKIM overlap-rotation pattern). ' +
			'Revocation on address deletion. Recovery kit (armored private key + plain-language instructions) offered at mint time + downloadable from settings; an import path for restores. NO ADMIN ESCROW (D7). ' +
			'INSTANCE_SECRET rotation: a versioned re-seal migration following the credentialCrypto version-pinning pattern; the backups UI gets the plain-words warning ("losing INSTANCE_SECRET without recovery kits means sealed history is gone"). ' +
			'ACCEPTANCE (QA later): rotate INSTANCE_SECRET on staging, run the migration, all sealed mail still opens.',
		tests:
			'NAMED TEST GATE: (a) rotation — the feed statement verifies; peer pinning (the E2 tests) upgrades silently; the old key decrypts but refuses to sign new mail; (b) recovery kit — export -> wipe -> import -> an old sealed fixture still opens; (c) re-seal migration — a mixed-version vault reads correctly mid-migration.',
	},
	{
		id: 'e7-two-instance-proof',
		kind: 'test',
		group: 'e2ee',
		dependsOn: ['e3-outbound-sealing', 'e4-inbound-unsealing', 'e5-trust-surfaces'],
		wave: 6,
		branch: 'sm/e7-two-instance-proof',
		title: 'test(api): two-instance E2EE proof suite + manual QA script',
		spec:
			'apps/api/convex/e2ee/__tests__/twoInstance.test.ts: TWO independent convex-test "instances" with separate secrets/keys + a loopback transport shim (captures what outbound.ts would hand the MTA and delivers it into the other instance\'s ingest). Full flow: discovery (mocked HTTP between them) -> seal -> ASSERT THE WIRE ARTIFACT CONTAINS NO PLAINTEXT CANARY -> open -> encryptionInfo verified -> key-swap on instance B => instance A\'s next send enters keyChanged. Keep the suite under ~60s (crypto is fast, instances are in-process). ' +
			'scripts/sealed-mail-qa.md: the two-real-instance manual checklist (staging VPS pair): WKD discovery from Thunderbird, sealed round-trip both directions, Proton interop one direction, MTA-STS external checker, DANE staging send, TLS-RPT report received, badge visual pass. ' +
			"This suite is the final PR's headline evidence.",
		tests:
			'NAMED TEST GATE: the two-instance suite itself, running in the standard api vitest run. (The QA markdown is a deliverable, not a test.)',
	},
	{
		id: 'e8b-sealed-at-rest',
		kind: 'feat',
		group: 'e2ee',
		dependsOn: ['e8a-message-body-accessor', 'e4-inbound-unsealing'],
		wave: 6,
		branch: 'sm/e8b-sealed-at-rest',
		title: 'feat(api): sealed at rest — all message bodies + .eml storage',
		spec:
			'Seal bodies (inboundMessages inline, mailMessages blobs + inline, unifiedMessages.content, drafts) and .eml storage with an instance data-key (domain string "owlat:at-rest:bodies:v1"); the decrypt shim lives in getMessageBody() — ONE function, because E8a made all ~30 readers go through it. ' +
			'Batched, RESUMABLE migration sealing existing rows (use the checkpointed-walker pattern already in the codebase); reads handle mixed sealed/plaintext during migration. ' +
			'DOCUMENTED EXCEPTIONS: search indexes + embeddings remain plaintext-derived (searchableText, vectors) — stated in code comments at the index definitions AND in docs; contacts/dataExport.ts decrypts on export. ' +
			'ACCEPTANCE: a backup/DB dump of a seeded instance contains zero message plaintext outside the documented search-index exception.',
		tests:
			'NAMED TEST GATE: (a) accessor round-trips across all four storage shapes, sealed AND legacy-plaintext rows; (b) migration test — interrupt/resume mid-batch, no row unreadable at any point; (c) export decrypts; the FULL existing api suite green (readers unchanged thanks to E8a); (d) CANARY CHECK — a DB/storage dump of a seeded convex-test instance contains no body canary string post-migration.',
	},
];

// Explicit wave/track layout from the plan manifest (hand-balanced for
// disjoint files; the two hot files mail/delivery.ts + mail/outbound.ts are
// serialized by this structure). A wave is an array of TRACKS; tracks run in
// parallel, pieces inside a track run SERIALLY (in-wave dependency chains
// like A1 -> A2).
const WAVES = [
	[['p0-scaffolding']],
	[['t1-tls-policy'], ['t6-secrets-at-rest'], ['a1-auth-verdicts', 'a2-reader-verdicts']],
	[['t2-mta-sts-publish'], ['t4-tls-rpt-dashboard'], ['a3-auth-badge'], ['a4-impersonation']],
	[
		['t3-dane'],
		['a5-arc'],
		['a6-alignment-guard'],
		['e1-key-vault'],
		['e8a-message-body-accessor'],
	],
	[['e2-discovery-tofu', 'e3-outbound-sealing']],
	[['e4-inbound-unsealing', 'e5-trust-surfaces']],
	[['e6-key-lifecycle'], ['e7-two-instance-proof'], ['e8b-sealed-at-rest']],
];

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

// ===========================================================================
// Prompt builders
// ===========================================================================
function wtPath(p) {
	return `${SCRATCH}/${p.id}`;
}

function buildPrompt(p) {
	const WT = wtPath(p);
	return (
		`You are the BUILDER thread for ONE sealed-mail piece. Implement it end-to-end IN A DEDICATED GIT WORKTREE with ATOMIC commits and open a PULL REQUEST against \`${BASE}\` (the integration branch — NOT ${MAIN}) on ${REPO}.\n\n` +
		CONV +
		`\n` +
		`PIECE: ${p.title}\nKIND: ${p.kind}\nBRANCH: ${p.branch}\nWORKTREE: ${WT}\n\n` +
		`STEP 0 — REUSE CHECK: run \`gh pr list --repo ${REPO} --head ${p.branch} --state open --json number,url,baseRefName\`. If an open PR already exists for this branch (base ${BASE}), DO NOT rebuild — return it with opened=true, reused=true, its number/url, and stop. ` +
		`Also check \`gh pr list --repo ${REPO} --head ${p.branch} --state merged --json number,url\` and spot-check whether the spec's key deliverables already exist on origin/${BASE} — a previous run may have merged this piece already. If the work has ALREADY LANDED on ${BASE}, do NOT rebuild and do NOT open an empty-diff PR: return alreadyLanded=true, opened=false, prNumber=<the merged PR number or 0>, with a one-line summary. Otherwise continue.\n\n` +
		`SPEC:\n${p.spec}\n\n` +
		`TESTS (HARD GATE — the reviewer rejects the PR if any named test surface is missing):\n${p.tests}\n\n` +
		`STEPS:\n` +
		`1. Sync + make a CLEAN worktree (never touch the main checkout):\n` +
		`   \`git -C "${ROOT}" fetch origin\`\n` +
		`   \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`\n` +
		`   \`git -C "${ROOT}" branch -D ${p.branch} 2>/dev/null || true\`\n` +
		`   \`git -C "${ROOT}" worktree add -B ${p.branch} "${WT}" origin/${BASE}\`\n` +
		`   Then do ALL edits under "${WT}" and ALL git ops with \`git -C "${WT}" …\`.\n` +
		`2. Read the ACTUAL current code first (spec file/line notes may have drifted — earlier pieces in this pipeline have already merged into ${BASE}; build on what is actually there). Then implement per the brief. ATOMIC commits (schema/backend, UI, tests, docs separate). NO AI attribution.\n` +
		`3. PREFLIGHT — run the local checks below and FIX everything they flag before pushing:\n${PREFLIGHT}` +
		`4. \`git -C "${WT}" push -u origin ${p.branch}\`.\n` +
		`5. Open the PR: \`gh pr create --repo ${REPO} --base ${BASE} --head ${p.branch} --title "<title>" --body "<body>"\`. Body: what changed and why (reference the shared product brief and the locked decision(s) this piece implements), the piece's acceptance criteria as a checklist with honest check states, the NAMED TESTS and where each landed, an inventory of preserved behavior, and a final line: "Sealed-mail pipeline: squash-merges into ${BASE} on reviewer approval + green CI; ${BASE} -> ${MAIN} ships later as one human-merged PR." Capture the PR number + URL.\n` +
		`6. Clean up the worktree (leave the branch pushed): \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`GitHub Actions will verify the push — you do not wait for it (but for P0 ONLY: follow the spec's STEP A verification that checks actually appear on this PR). If you truly cannot complete the piece, still push what is coherent and open the PR as a draft (\`--draft\`) with blockReason in the body and opened=true, OR — if nothing shippable exists — set opened=false with blockReason. Return the structured result.`
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
		`Classify: state="pass" if every check is pass/skipping/neutral; "fail" if ANY check failed; "pending" if any is queued/in_progress and none failed; "unknown" if NONE reported yet. NOTE: this PR targets the ${BASE} base branch — if state is "unknown" after several polls, say so explicitly in the summary (it may mean the Actions branch filters do not cover integration/* yet). List failing check names. Do NOT modify anything.`
	);
}

function reviewPrompt(p, build, round) {
	return (
		`You are THE reviewer for PR #${build.prNumber} (${build.prUrl}) on ${REPO} (base branch: ${BASE}). Review ROUND ${round}. You are the single quality gate — you cover ALL areas below in one pass. The bar is: we only want the highest quality of code, and NO PIECE MERGES WITHOUT THE TESTS NAMED ON ITS CARD.\n\n` +
		`REVIEW AREAS (cover every one; area 0 is the hard test gate):\n${REVIEWER_FOCUS}\n\n` +
		`THE SHARED PRODUCT BRIEF this PR must conform to:\n${BRIEF}\n\n` +
		`The PR implements this piece of the reviewed sealed-mail plan — judge it against THIS intent:\nPIECE: ${p.title}\nSPEC:\n${p.spec}\nNAMED TESTS (the hard gate):\n${p.tests}\n\n` +
		`HOW TO REVIEW (read-only — do NOT checkout/modify the working tree or run the app):\n` +
		`- \`gh pr diff ${build.prNumber} --repo ${REPO}\` for the full diff; \`gh pr view ${build.prNumber} --repo ${REPO} --json title,body,commits,comments\` for context + prior-round comments.\n` +
		`- For full file context at the PR head without disturbing the tree: \`git fetch origin ${build.branch}\` then \`git show origin/${build.branch}:<path>\`. Read neighboring files on origin/${BASE} the same way when you need conventions context (e.g. apps/api/convex/CONVENTIONS.md).\n` +
		(round > 1
			? `- This is a RE-REVIEW: FIRST check whether your prior round's findings (blocking AND improvements) were addressed in the new commits. New findings are allowed only if the fix commits introduced them or you find a genuinely new defect — do not drip-feed nits you could have raised earlier.\n`
			: ``) +
		`\nFINDINGS POLICY — two buckets, BOTH get fixed:\n` +
		`- blockingFindings: defects — the test gate unmet (any named test surface missing or hollow), security/permission issues (especially: any path returning private key material, missing SSRF guards on discovery fetches, fail-open verdict/signature handling, plaintext leakage on sealed paths, e2ee functions not behind the secure wrappers), spec violations, brief/locked-decision violations (flag default ON, mixed sends, admin escrow, campaigns touched), missing schema/api.d.ts registration, broken/missing required tests, failing CI causes.\n` +
		`- improvements: everything that would make this the highest-quality version of itself — code-smell hits from the catalog, best-practice deviations, naming, small simplifications, better types. These are NOT optional notes: the author is instructed to address every one. Only report CONCRETE, actionable items with file:line and the fix — no vague "consider..." advice, no pure-taste style preferences, no speculative redesigns beyond the piece scope.\n\n` +
		`DECIDE: verdict="approve" ONLY if there are ZERO blocking findings AND ZERO unaddressed improvements AND the piece genuinely delivers its spec AND every named test surface exists and asserts the card's claims AND CI is not failing. If anything remains, verdict="request_changes" listing every item.\n\n` +
		`POST your review as ONE PR comment: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Review — round ${round}\\n\\n**Verdict: APPROVE|REQUEST_CHANGES**\\n\\n### Test gate\\n<met / unmet: which named tests are missing>\\n\\n### Blocking\\n<list or 'none'>\\n\\n### Improvements\\n<list or 'none'>"\` (markdown lists with file:line). (Use a comment, NOT \`gh pr review\` — you cannot formally review a PR opened by your own gh user.)\n\n` +
		`Then return the structured verdict (it drives the pipeline's approval gate).`
	);
}

function addressPrompt(p, build, review, ci, round) {
	const WT = wtPath(p);
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
		`You are the AUTHOR thread for PR #${build.prNumber} (${build.prUrl}) on ${REPO}, branch ${build.branch}, base ${BASE}. Address the reviewer's ACTUAL PR comments and push fixes. Fix ROUND ${round}.\n\n` +
		CONV +
		`\n` +
		`PIECE: ${p.title}\nSPEC (intent to preserve):\n${p.spec}\n\nNAMED TESTS (hard gate — if the reviewer says one is missing, ADD it):\n${p.tests}\n\n` +
		`FINDINGS TO RESOLVE — address EVERY item, including the small improvements (the bar is the highest-quality version of this change, not merely a passing one):\n${findings || '(re-read the live PR comments)'}\n${ciNote}\n` +
		`Also read live comments: \`gh pr view ${build.prNumber} --repo ${REPO} --json comments\`.\n\n` +
		`STEPS:\n` +
		`1. Clean worktree at the PR head: \`git -C "${ROOT}" fetch origin ${build.branch}\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${build.branch}\`; then work under "${WT}" with \`git -C "${WT}"\`. (Detached HEAD is fine — you push explicitly.)\n` +
		`2. Fix each blocking finding (and any CI failure). If you believe a finding is wrong, that is allowed — justify it in the PR response and in \`unresolved\`. ATOMIC commits, NO AI attribution.\n` +
		`3. PREFLIGHT before re-pushing — run the local checks below and fix everything they flag:\n${PREFLIGHT}` +
		`4. Push: \`git -C "${WT}" push origin HEAD:${build.branch}\`. Post a response: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Author response — round ${round}\\n\\n<what you addressed per reviewer + anything intentionally unchanged with reason>"\`. Then \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`Return the structured result.`
	);
}

function mergePrompt(p, build, approved, ci) {
	const WT = wtPath(p);
	const green = ci && ci.state === 'pass';
	const ready = approved && green;
	return (
		`You are the MERGE gate for PR #${build.prNumber} (${build.prUrl}) on ${REPO}, branch ${build.branch}, BASE BRANCH ${BASE} (the integration branch — this pipeline NEVER merges to ${MAIN}). The unified reviewer ${approved ? 'APPROVED' : 'did NOT approve within the round budget'}; GitHub CI state is "${ci ? ci.state : 'unknown'}"${ci && ci.failing && ci.failing.length ? ' (failing: ' + ci.failing.join(', ') + ')' : ''}.\n\n` +
		(ready
			? `BOTH conditions are met (reviewer approval + CI green). This pipeline's merge policy was explicitly authorized by the repo owner (comment-verdict reviews stand in for formal approvals since the PR author and reviewer share one gh user). MERGE the PR now:\n` +
				`1. FIRST verify the base: \`gh pr view ${build.prNumber} --repo ${REPO} --json baseRefName\` must say ${BASE} — if it says anything else, DO NOT merge; return merged=false with the reason.\n` +
				`2. \`gh pr merge ${build.prNumber} --repo ${REPO} --squash --delete-branch\`.\n` +
				`3. If it fails because the branch is BEHIND ${BASE} (possible — sibling pieces merge in parallel), attempt ONE CLEAN rebase (never touch the main checkout): \`git -C "${ROOT}" fetch origin\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${build.branch}\`; \`git -C "${WT}" rebase origin/${BASE}\`.\n` +
				`   - If the rebase completes with NO conflicts: \`git -C "${WT}" push --force-with-lease origin HEAD:${build.branch}\`, remove the worktree, retry the merge (you may repeat this clean-rebase+retry up to TWO times — parallel merges race).\n` +
				`   - If the rebase STOPS ON CONFLICTS: capture the conflicted paths FIRST (\`git -C "${WT}" diff --name-only --diff-filter=U\`), then \`git -C "${WT}" rebase --abort\`, remove the worktree, and return merged=false, conflict=true, conflictFiles=<those paths>, with a one-line outstanding entry. Do NOT hand-resolve conflict hunks yourself — a dedicated resolver thread with the piece's full spec context handles that; your job is only to DETECT and CLASSIFY.\n` +
				`4. Confirm merged: \`gh pr view ${build.prNumber} --repo ${REPO} --json state,mergeCommit\`. Return merged=true with the merge commit only if state=MERGED.\n` +
				`If the merge cannot complete for a NON-conflict reason (protected-branch block, API error), return merged=false, conflict=false with the reason in outstanding — do NOT force anything unsafe.\n`
			: `NOT ready to merge (${approved ? 'CI not green' : 'reviewer did not approve'}). DO NOT MERGE. Post a PR comment summarizing exactly what still blocks merge (outstanding findings and/or failing checks) so a human can pick it up, and return merged=false with those items in \`outstanding\`.\n`) +
		`Return the structured result.`
	);
}

function resolveConflictPrompt(p, build, conflictFiles, attempt) {
	const WT = `${wtPath(p)}-resolve`;
	return (
		`You are the CONFLICT RESOLVER for PR #${build.prNumber} (${build.prUrl}) on ${REPO}, branch ${build.branch}, base ${BASE}. Attempt ${attempt}. The merge gate found the branch conflicts with ${BASE} after sibling pieces of this pipeline merged. Your job: rebase the branch onto origin/${BASE} and resolve every conflict SEMANTICALLY — you have the piece's full spec below, and the conflicting changes on ${BASE} come from sibling pieces of the same reviewed plan, so BOTH sides are intentional and BOTH intents must survive.\n\n` +
		CONV +
		`\n` +
		`PIECE (this branch's intent): ${p.title}\nSPEC:\n${p.spec}\n\n` +
		`KNOWN CONFLICTED FILES (from the merge gate's probe): ${conflictFiles && conflictFiles.length ? conflictFiles.join(', ') : '(unknown — discover during rebase)'}\n\n` +
		`STEPS:\n` +
		`1. Dedicated worktree (never touch the main checkout): \`git -C "${ROOT}" fetch origin\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${build.branch}\`; then \`git -C "${WT}" rebase origin/${BASE}\`.\n` +
		`2. UNDERSTAND BEFORE RESOLVING each conflicted file: read the full conflicted file, then BOTH parents — \`git -C "${WT}" show REBASE_HEAD:<path>\` (this branch's version) and \`git -C "${WT}" show origin/${BASE}:<path>\` (what landed) — plus \`git -C "${WT}" log --oneline -8 origin/${BASE} -- <path>\` to see WHICH sibling piece changed it and why.\n` +
		`3. RESOLUTION POLICY: preserve BOTH behaviors — the sibling piece's merged change AND this piece's spec'd change. Never delete either side to make the conflict go away. If both sides restructured the same code incompatibly, keep ${BASE}'s structure as the base and RE-EXPRESS this piece's intent on top of it (the integration branch is the source of truth for architecture). If a conflict reveals the two pieces genuinely contradict, STOP: return resolved=false with blockReason naming both sides — do not guess.\n` +
		`4. Continue the rebase to completion (\`git -C "${WT}" rebase --continue\` after each resolved commit; keep the branch's atomic-commit structure — do NOT squash during resolution).\n` +
		`5. PREFLIGHT the files you touched during resolution (oxfmt + oxlint as below) and self-review types:\n${PREFLIGHT}` +
		`6. Push: \`git -C "${WT}" push --force-with-lease origin HEAD:${build.branch}\`. Post a PR comment: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Conflict resolution\\n\\nRebased onto ${BASE}; resolved: <files + one line each on how both intents were preserved>"\`. Clean up: \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`GitHub Actions re-verifies the force-push — you do not wait for it. Return the structured result (resolved, pushed, files touched).`
	);
}

function mainSyncPrompt(waveNo) {
	const WT = `${SCRATCH}/main-sync-w${waveNo}`;
	return (
		`You are the MAIN-SYNC thread for the sealed-mail pipeline, after wave ${waveNo}. FRESHNESS RULE: merge origin/${MAIN} INTO the integration branch ${BASE} so the final giant PR stays reviewable instead of a mega-conflict. TRUNK WINS on conflict (the established resolution rule) — but "wins" means main's version is the BASE STRUCTURE; re-express the sealed-mail change on top of it, never silently drop a sealed-mail behavior.\n\n` +
		`STEPS (never touch the main checkout at ${ROOT} beyond \`git -C\` commands):\n` +
		`1. \`git -C "${ROOT}" fetch origin\`. Check whether a merge is even needed: \`git -C "${ROOT}" rev-list --count origin/${BASE}..origin/${MAIN}\` — if 0, return merged=true, pushed=false, conflicts=[], summary="integration branch already contains main". \n` +
		`2. \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${BASE}\` (detached); \`git -C "${WT}" merge origin/${MAIN} -m "merge: main into ${BASE} (post-wave ${waveNo} freshness sync)"\`.\n` +
		`3. If conflicts: resolve per the trunk-wins policy above — for each conflicted file read both sides (\`git -C "${WT}" show HEAD:<path>\` vs \`git -C "${WT}" show origin/${MAIN}:<path>\`), take main's structure, re-apply the sealed-mail intent on top, \`git add\` and complete the merge commit. If apps/api/convex/_generated/api.d.ts conflicts, regenerate the union by hand (keep BOTH sides' module entries — it is a type manifest, both are additive). Preflight-format any file you hand-edited (\`oxfmt --config "${ROOT}/oxfmtrc.json" --write <files>\`).\n` +
		`4. Push: \`git -C "${WT}" push origin HEAD:${BASE}\`. Clean up: \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n` +
		`5. If a conflict is genuinely unresolvable without dropping one side's behavior, abort the merge, push NOTHING, and return merged=false with blockReason — a human decides.\n\n` +
		`NO AI attribution in the merge commit. Return the structured result (merged, pushed, conflicts=<files that had conflicts>, summary).`
	);
}

// ===========================================================================
// Orchestrator helpers
// ===========================================================================

// Review with the Fable->Opus fallback latch: use Fable while usage remains;
// the first time a Fable review returns null (usage/limit exhaustion or a
// terminal error), latch REVIEW_MODEL to Opus for the rest of the run and
// retry this review once on Opus.
let REVIEW_MODEL = 'fable';
async function runReview(p, build, round) {
	const opts = {
		label: `review:${p.id}:r${round}`,
		phase: 'Review',
		schema: REVIEW_SCHEMA,
		effort: 'high',
	};
	let review = await agent(reviewPrompt(p, build, round), { ...opts, model: REVIEW_MODEL });
	if (!review && REVIEW_MODEL === 'fable') {
		REVIEW_MODEL = 'opus';
		log(
			`${p.id} review r${round}: Fable unavailable — falling back to Opus for the remainder of the run`
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
// Returns a result record; never throws (parallel siblings must not die together).
async function runPiece(p, idx, total, mergedSet) {
	const failedDeps = (p.dependsOn || []).filter((d) => !mergedSet.has(d));
	if (failedDeps.length) {
		log(`${p.id} — SKIPPED (unmerged deps: ${failedDeps.join(', ')})`);
		return {
			piece: p.id,
			opened: false,
			merged: false,
			reason: 'skipped: unmerged deps ' + failedDeps.join(','),
		};
	}
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
			log(`${p.id} already landed on ${BASE} (PR #${build.prNumber || '?'}) — counting as merged`);
			return {
				piece: p.id,
				opened: false,
				merged: true,
				prNumber: build.prNumber,
				reason: 'already landed on ' + BASE,
			};
		}
		if (!build || !build.opened || !build.prNumber) {
			log(`build failed for ${p.id}: ${(build && build.blockReason) || 'agent died / rate limit'}`);
			return {
				piece: p.id,
				opened: false,
				merged: false,
				reason: (build && build.blockReason) || 'build agent failed',
			};
		}
		log(`${p.id} -> PR #${build.prNumber}${build.reused ? ' (reused)' : ''} ${build.prUrl}`);

		// ADOPTED PR: a previous run may have left a reviewer verdict as the last
		// word on the PR. If so, address its concerns FIRST.
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

		// Unified reviewer (Fable->Opus latch) <-> Opus author loop until approve AND CI green.
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

		// Merge on approve+green; a detected CONFLICT spawns a dedicated Opus
		// resolver, CI re-verifies, then the merge retries.
		let merged = false;
		let mergeOut = [];
		if (AUTO_MERGE) {
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
					mergeOut = [
						'conflict resolution failed: ' + ((res && res.blockReason) || 'resolver died'),
					];
					log(`${p.id} resolver did not push — leaving for human (${mergeOut[0]})`);
					break;
				}

				ci = await waitForCi(build.prNumber, p.id);
				if (ci.state !== 'pass') {
					await agent(addressPrompt(p, build, null, ci, MAX_ROUNDS + attempt), {
						label: `address:${p.id}:post-resolve${attempt}`,
						phase: 'Address',
						schema: ADDRESS_SCHEMA,
						model: 'opus',
						effort: 'medium',
					});
					ci = await waitForCi(build.prNumber, p.id);
					if (ci.state !== 'pass') {
						mergeOut = ['CI not green after conflict resolution'];
						log(`${p.id} CI still ${ci.state} after post-resolve repair — leaving for human`);
						break;
					}
				}
			}
			log(
				`${p.id} ${merged ? 'MERGED into ' + BASE : 'NOT merged'}${merged ? '' : ' — ' + mergeOut.join('; ')}`
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
			outstanding: mergeOut,
		};
	} catch (e) {
		log(`${p.id} FAILED (caught): ${String(e).slice(0, 160)} — continuing`);
		return {
			piece: p.id,
			opened: false,
			merged: false,
			reason: 'caught: ' + String(e).slice(0, 140),
		};
	}
}

// ===========================================================================
// Driver — explicit WAVES of parallel TRACKS (serial inside a track, so
// in-wave dependency chains like A1 -> A2 work). Waves are barriers. After
// each wave with >=1 merge, origin/main is merged INTO the integration
// branch (trunk wins). On a rate-limit/stall resume: add merged ids to
// MERGED_IDS and relaunch FRESH — builders branch from origin/BASE, and the
// reuse-check adopts still-open PRs from the previous run. TRUST
// `gh pr list --state merged` over a resumed run's cached result JSON.
// ===========================================================================
const byId = Object.fromEntries(PIECES.map((p) => [p.id, p]));
const MERGED_IDS = [
	// Add piece ids here when resuming after a stall (confirmed merged into the
	// integration branch via `gh pr list --repo wolvesdotink/owlat --base integration/sealed-mail --state merged`).
];
const RUN_WAVES = WAVES.map((wave) =>
	wave
		.map((track) => track.filter((id) => !MERGED_IDS.includes(id)))
		.filter((track) => track.length > 0)
).filter((wave) => wave.length > 0);

const total = RUN_WAVES.flat(2).length;
log(
	`sealed-mail-prs: ${total} piece(s) in ${RUN_WAVES.length} wave(s) (auto-merge=${AUTO_MERGE}) vs ${REPO}, base ${BASE}`
);
RUN_WAVES.forEach((w, i) => log(`wave ${i + 1}: ${w.map((t) => t.join(' -> ')).join(' | ')}`));

const results = [];
const mergedSet = new Set(MERGED_IDS);
let counter = 0;

for (let w = 0; w < RUN_WAVES.length; w++) {
	const wave = RUN_WAVES[w];
	phase(`Wave ${w + 1}`);
	log(`=== wave ${w + 1}/${RUN_WAVES.length}: ${wave.map((t) => t.join(' -> ')).join(' | ')} ===`);

	// Tracks in parallel; pieces inside a track serially (later track pieces
	// depend on earlier ones — the dep-gate in runPiece enforces it too).
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
	const wavePieceCount = wave.flat().length;
	log(`wave ${w + 1} done: ${waveMergedCount}/${wavePieceCount} merged into ${BASE}`);

	if (ABORT_IF_WHOLE_WAVE_FAILS && wavePieceCount > 1 && waveMergedCount === 0) {
		log(
			`ABORT: entire wave ${w + 1} failed to merge — likely rate limit or systemic issue. Fix and resume via MERGED_IDS.`
		);
		break;
	}

	// Freshness rule: after each wave with merges, fold main INTO the
	// integration branch (trunk wins) so the final giant PR stays reviewable.
	if (waveMergedCount > 0) {
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
const openedNotMerged = results.filter((r) => r.opened && !r.merged);
log(
	`DONE — ${mergedCount}/${total} merged into ${BASE}; ${openedNotMerged.length} opened-but-unmerged. Final ${BASE} -> ${MAIN} PR is opened by a HUMAN per the ship checklist.`
);
return {
	repo: REPO,
	base: BASE,
	mergedCount,
	total,
	waves: RUN_WAVES.map((w) => w.map((t) => t.join('->'))),
	results,
};
