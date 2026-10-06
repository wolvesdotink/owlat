// Rule test for webhook-signature-read-outside-verifier: this read form
// (a backtick inside a single-quoted name) is still a signature-header read. The file is not in the
// rule's allowlist, so the read is reported. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/read-forms/get-backtick.ts

// prettier-ignore
export function getBacktick(req, get) {
	// ruleid: webhook-signature-read-outside-verifier
	const sig = req.headers.get('x-`signature');
	if (!sig) return 401;
	return 200;
}
