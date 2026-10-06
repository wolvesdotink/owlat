// Rule test for webhook-signature-read-outside-verifier: this read form
// (an apostrophe inside a detached get name) is still a signature-header read. The file is not in the
// rule's allowlist, so the read is reported. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/read-forms/detached-get-apostrophe.ts

// prettier-ignore
export function detachedGetApostrophe(req, get) {
	// ruleid: webhook-signature-read-outside-verifier
	const sig = get("x-'signature");
	if (!sig) return 401;
	return 200;
}
