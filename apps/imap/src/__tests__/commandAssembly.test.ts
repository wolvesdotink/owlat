import { describe, expect, it } from 'vitest';
import { admitFinalSegment, admitLiteral, type PendingCommand } from '../commandAssembly.js';
import { parseCommandWithLiterals } from '../parser.js';

const limits = { preAuth: false, maxLiteralBytes: 64 * 1024, maxLineBytes: 1024 };

function admitted(pending: PendingCommand | null, line: string, octets: number): PendingCommand {
	const admission = admitLiteral(pending, line, Buffer.byteLength(line), octets, limits);
	if (!admission.ok) throw new Error(admission.reason);
	return admission.pending;
}

describe('commandAssembly', () => {
	it('records a zero-length literal so later literals keep their positions', () => {
		// `a LOGIN {0}` + `` + ` {8}` + `password` + ``: the empty literal is the
		// user, `password` the password. Absorbed literals are appended by the
		// pump; a zero-length one has nothing to absorb.
		let pending = admitted(null, 'a LOGIN {0}', 0);
		pending = admitted(pending, ' {8}', 8);
		pending.literals.push('password');
		expect(admitFinalSegment(pending, '', 0, limits)).toBe(true);

		expect(pending.segments).toHaveLength(pending.literals.length + 1);
		expect(parseCommandWithLiterals(pending.segments, pending.literals)?.args).toEqual([
			'',
			'password',
		]);
	});

	it('counts literal declarations, including zero-length ones', () => {
		let pending: PendingCommand | null = null;
		for (let i = 0; i < 1024; i += 1) pending = admitted(pending, 'x{0}', 0);
		expect(admitLiteral(pending, 'x{0}', 4, 0, limits)).toEqual({
			ok: false,
			reason: 'Command too large',
		});
	});
});
