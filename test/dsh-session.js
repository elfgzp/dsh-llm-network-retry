/**
 * Load the REAL DeepSeek Harness session packages from the running installation.
 *
 * The point of the replay test is the interaction with the harness's own session
 * reader, not with a copy of its rules: a synthetic log is handed to the shipped
 * `dsh-session-format-catalog` restore path, which runs the same v4 relationship
 * validation that refuses a corrupt log at load time ("history failed to load").
 * A test that re-implemented those rules would happily pass the very log that
 * bricked a conversation, so this helper deliberately loads the installed code.
 *
 * The packages are not dependencies of this plugin, so an absent installation
 * skips the suite rather than failing a contributor's machine.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Candidate roots holding `@deepseek-ai/dsh-session*` packages. */
const CANDIDATES = [
  process.env.DSH_SESSION_PACKAGE_ROOT,
  '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  path.join(process.env.HOME ?? '', 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
].filter((root) => typeof root === 'string' && root.length > 0);

let cached;

/**
 * Import the installed session packages.
 * @returns `{ catalog, session }` module namespaces, or `null` when this
 *   machine has no harness installation to validate against.
 */
export async function loadSessionPackages() {
  if (cached !== undefined) return cached;
  cached = null;
  for (const root of CANDIDATES) {
    const catalogEntry = path.join(root, 'dsh-session-format-catalog/lib/index.js');
    const sessionEntry = path.join(root, 'dsh-session/lib/index.js');
    if (!existsSync(catalogEntry) || !existsSync(sessionEntry)) continue;
    try {
      const [catalog, session] = await Promise.all([
        import(new URL(`file://${catalogEntry}`).href),
        import(new URL(`file://${sessionEntry}`).href),
      ]);
      cached = { catalog, session, root };
      return cached;
    } catch {
      // A partially installed tree is not worth failing over.
    }
  }
  return null;
}
