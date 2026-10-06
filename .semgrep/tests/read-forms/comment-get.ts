// Rule test for webhook-signature-read-outside-verifier: this read form
// (comment get) is still a signature-header read. The file is
// not in the rule's allowlist, so the read is reported. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/read-forms/comment-get.ts

// prettier-ignore
export function commentGet(req, expected) {
	// ruleid: webhook-signature-read-outside-verifier
	const sig = req.headers.get /* read */ ('x-signature');
	if (!sig) return 401;
	return 200;
}
