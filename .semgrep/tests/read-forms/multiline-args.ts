// Rule test for webhook-signature-read-outside-verifier: this read form
// (multiline args) is still a signature-header read. The file is
// not in the rule's allowlist, so the read is reported. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/read-forms/multiline-args.ts

// prettier-ignore
export function multilineArgs(req, expected) {
	// ruleid: webhook-signature-read-outside-verifier
	const sig = req.headers.get(
	'X-SIGNATURE'
	);
	if (!sig) return 401;
	return 200;
}
