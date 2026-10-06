// Rule test for webhook-signature-read-outside-verifier: this read form
// (an apostrophe inside a bracketed name) is still a signature-header read. The file is not in the
// rule's allowlist, so the read is reported. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/read-forms/bracket-apostrophe.ts

// prettier-ignore
export function bracketApostrophe(req, get) {
	// ruleid: webhook-signature-read-outside-verifier
	const sig = req.headers["x-'signature"];
	if (!sig) return 401;
	return 200;
}
