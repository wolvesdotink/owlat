/**
 * The **IMAP command walker** — typed dispatch registry + CAPABILITY-line
 * assembly. Holds one entry per supported `ImapVerb`; missing a verb
 * makes the line BAD without crashing the pump. Multi-verb modules
 * (LIST + LSUB, SELECT + EXAMINE, UNSELECT + CLOSE) install themselves
 * under each verb they declare.
 *
 * Mirrors the **Step walker** (automations) and **Agent walker** (inbox
 * agent pipeline) shapes — typed registry, pure modules, walker owns
 * the parse-and-start ceremony.
 */

import { matchTrailingLiteral, parseLine, type ArgForm, type ParsedCommand } from '../parser.js';
import type {
	CommandDeps,
	CommandSession,
	ConnectionState,
	ImapCommandModule,
	ImapVerb,
} from './types.js';
import { checkRequires } from './helpers/auth.js';
import { syncSession } from './helpers/session.js';

/**
 * The environment the walker hands to an erased module's `dispatch`: the
 * raw command frame plus the pump deps/state. Mirrors `StartArgs` minus
 * the per-verb `args`, which the module recovers itself from `rawArgs`.
 */
interface DispatchEnv {
	readonly deps: CommandDeps;
	readonly state: ConnectionState;
	readonly rawArgs: string[];
	readonly argForms?: readonly ArgForm[];
	readonly tag: string;
	readonly verb: ImapVerb;
	readonly send: (line: string | Buffer) => void;
}

/**
 * A module with its `TArgs` existentially closed away. `erase` binds each
 * concrete module's `parseArgs` → `checkRequires` → `start` chain inside
 * `dispatch`, so the registry can hold modules of differing arg types
 * under one uniform shape without an `any` — the type variable lives only
 * inside the closure, where parse output and start input share the same
 * `TArgs`.
 */
interface ErasedCommandModule {
	readonly verbs: readonly ImapVerb[];
	readonly capabilities?: readonly string[];
	concurrent(rawArgs: string[], argForms?: readonly ArgForm[]): boolean;
	dispatch(env: DispatchEnv): CommandSession;
}

function erase<TArgs>(m: ImapCommandModule<TArgs>): ErasedCommandModule {
	return {
		verbs: m.verbs,
		capabilities: m.capabilities,
		concurrent(rawArgs, argForms) {
			const parsed = m.parseArgs(rawArgs, argForms);
			return parsed.ok && (m.concurrent?.(parsed.args) ?? false);
		},
		dispatch(env) {
			const parseResult = m.parseArgs(env.rawArgs, env.argForms);
			if (!parseResult.ok) {
				env.send(`${env.tag} BAD ${parseResult.error}`);
				return syncSession();
			}
			const unmet = checkRequires(m.requires, env.state, env.tag);
			if (unmet) {
				env.send(unmet);
				return syncSession();
			}
			return m.start({
				deps: env.deps,
				state: env.state,
				args: parseResult.args,
				tag: env.tag,
				verb: env.verb,
				send: env.send,
			});
		},
	};
}

import { appendModule } from './append/index.js';
import { authenticateModule } from './authenticate/index.js';
import { capabilityModule } from './capability/index.js';
import { checkModule } from './check/index.js';
import { copyModule } from './copy/index.js';
import { enableModule } from './enable/index.js';
import { expungeModule } from './expunge/index.js';
import { fetchModule } from './fetch/index.js';
import { idModule } from './id/index.js';
import { idleModule } from './idle/index.js';
import { listModule } from './list/index.js';
import { loginModule } from './login/index.js';
import { logoutModule } from './logout/index.js';
import { moveModule } from './move/index.js';
import { namespaceModule } from './namespace/index.js';
import { noopModule } from './noop/index.js';
import { selectModule } from './select/index.js';
import { statusModule } from './status/index.js';
import { storeModule } from './store/index.js';
import { uidModule } from './uid/index.js';
import { unselectModule } from './unselect/index.js';

const MODULES: readonly ErasedCommandModule[] = [
	erase(appendModule),
	erase(authenticateModule),
	erase(capabilityModule),
	erase(checkModule),
	erase(copyModule),
	erase(enableModule),
	erase(expungeModule),
	erase(fetchModule),
	erase(idModule),
	erase(idleModule),
	erase(listModule),
	erase(loginModule),
	erase(logoutModule),
	erase(moveModule),
	erase(namespaceModule),
	erase(noopModule),
	erase(selectModule),
	erase(statusModule),
	erase(storeModule),
	erase(uidModule),
	erase(unselectModule),
];

const REGISTRY: Partial<Record<ImapVerb, ErasedCommandModule>> = {};
for (const m of MODULES) {
	for (const v of m.verbs) {
		REGISTRY[v] = m;
	}
}

/**
 * Whether `verb` has a registered module. The registry is built at runtime,
 * so the compiler cannot see a verb that lost its `MODULES` entry;
 * `__tests__/walker.test.ts` checks every `IMAP_VERBS` entry through this.
 */
export function hasModule(verb: ImapVerb): boolean {
	return REGISTRY[verb] !== undefined;
}

/**
 * Whether a complete command line may start while earlier commands are still
 * running: its module declares it `concurrent` for these args. A line that
 * opens a literal never does, nor does an unknown verb.
 */
export function runsConcurrently(line: string): boolean {
	if (matchTrailingLiteral(line)) return false;
	const parsed = parseLine(line);
	if (!parsed) return false;
	return REGISTRY[parsed.command as ImapVerb]?.concurrent(parsed.args, parsed.argForms) ?? false;
}

/**
 * Atoms every IMAP4rev1 server announces regardless of which modules
 * are registered. Module-contributed atoms (IDLE, LITERAL+, MOVE, …)
 * fold in below. `AUTH=PLAIN` / `LOGINDISABLED` are *not* listed here —
 * they depend on the connection's TLS state and are added by
 * `assembleCapabilityLine` so we never advertise plaintext credential
 * mechanisms over an unencrypted channel (RFC 3501 §11.1, RFC 2595).
 */
const BASE_CAPABILITY_ATOMS: readonly string[] = ['IMAP4rev1'];

/**
 * Assemble the `CAPABILITY` line for a connection in a given TLS state.
 *
 *   - **TLS** — advertise `AUTH=PLAIN` (the AUTHENTICATE module) and allow
 *     the plaintext-credential `LOGIN` command.
 *   - **plaintext (dev fallback)** — advertise `LOGINDISABLED` and omit
 *     `AUTH=PLAIN`, so a conformant client never sends credentials in the
 *     clear. `LOGIN` / `AUTHENTICATE PLAIN` are both refused at runtime
 *     with `[PRIVACYREQUIRED]`.
 *
 * RFC 3501 §11.1 / §6.2.1; RFC 2595.
 */
export function assembleCapabilityLine(tls: boolean): string {
	const atoms = new Set<string>(BASE_CAPABILITY_ATOMS);
	for (const m of MODULES) {
		for (const c of m.capabilities ?? []) atoms.add(c);
	}
	if (tls) {
		atoms.add('AUTH=PLAIN');
	} else {
		atoms.add('LOGINDISABLED');
	}
	return `CAPABILITY ${Array.from(atoms).join(' ')}`;
}

/**
 * Look up the module for the parsed verb, run its `parseArgs`, check
 * its declared `requires`, and hand off to `start`. Unknown verbs and
 * parse failures emit a BAD line, an unmet precondition emits the
 * `checkRequires` reply, and each returns a closed one-shot session
 * without starting the module.
 */
export function dispatch(
	deps: CommandDeps,
	state: ConnectionState,
	parsed: ParsedCommand,
	send: (line: string | Buffer) => void
): CommandSession {
	const verb = parsed.command as ImapVerb;
	const module = REGISTRY[verb];
	if (!module) {
		send(`${parsed.tag} BAD Command "${parsed.command}" not supported`);
		return syncSession();
	}
	return module.dispatch({
		deps,
		state,
		rawArgs: parsed.args,
		argForms: parsed.argForms,
		tag: parsed.tag,
		verb,
		send,
	});
}
