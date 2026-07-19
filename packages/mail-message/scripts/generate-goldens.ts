/**
 * Regenerate the golden `.eml` corpus (piece R2). Run with:
 *
 *   bun run goldens:update          # from packages/mail-message
 *   bun --cwd packages/mail-message run goldens:update   # from the repo root
 *
 * It (re)writes one `<case>.eml` under `__tests__/golden/` for every M2 corpus
 * case by composing + DKIM-signing it through {@link buildGolden} — the same path
 * the byte-diff test recomputes — and DELETES any orphan `.eml` whose case was
 * removed from the corpus, so the committed set always mirrors the corpus exactly.
 *
 * This is the ONLY sanctioned way to update the goldens: a golden must never be
 * hand-edited (that would defeat the byte-for-byte gate). When a legitimate
 * change to the composer or signer moves the bytes, run this script, eyeball the
 * git diff, and commit the regenerated corpus alongside the code change.
 *
 * Generation is deterministic (fixed boundary seeds, pinned message-id/date, a
 * frozen sign time and a fixed test key), so re-running with no code change
 * leaves the working tree clean.
 */

import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildGolden, GOLDEN_CASES, GOLDEN_DIR, goldenFileName } from '../__tests__/golden/goldens';

function main(): void {
	const expected = new Set<string>();

	for (const testCase of GOLDEN_CASES) {
		const fileName = goldenFileName(testCase);
		expected.add(fileName);
		writeFileSync(join(GOLDEN_DIR, fileName), buildGolden(testCase));
	}

	let removed = 0;
	for (const entry of readdirSync(GOLDEN_DIR)) {
		if (entry.endsWith('.eml') && !expected.has(entry)) {
			unlinkSync(join(GOLDEN_DIR, entry));
			removed += 1;
		}
	}

	// eslint-disable-next-line no-console
	console.log(
		`goldens: wrote ${expected.size.toString()} .eml file(s)` +
			(removed > 0 ? `, removed ${removed.toString()} orphan(s)` : '') +
			` in ${GOLDEN_DIR}`
	);
}

main();
