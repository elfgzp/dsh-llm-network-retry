/**
 * Load the shipped `@deepseek-ai/dsh-llm-retry` executor from the running dsh
 * installation.
 *
 * The package lives inside `app.asar`, which only Electron's patched loader can
 * read, so plain Node imports fail. This helper reads the asar header itself and
 * extracts just that package into a temp directory once per process — the test
 * then exercises the REAL shipped code rather than a copy committed to this repo,
 * so an upstream change to its waterfall semantics shows up here.
 */
import { open, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const PREFIX = 'dsh/node_modules/@deepseek-ai/dsh-llm-retry';

/** Read the asar directory index into a flat `path → entry` map. */
async function readAsarIndex(handle) {
  const head = Buffer.alloc(16);
  await handle.read(head, 0, 16, 0);
  const headerSize = head.readUInt32LE(12);
  const headerBuf = Buffer.alloc(headerSize);
  await handle.read(headerBuf, 0, headerSize, 16);
  const header = JSON.parse(headerBuf.toString('utf8'));
  const entries = new Map();
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, full);
      else entries.set(full, child);
    }
  })(header, '');
  return { entries, baseOffset: 8 + head.readUInt32LE(4) };
}

let cached;

/** Absolute asar URL of the shipped executor's entry module. */
const ASAR_ENTRY =
  'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js';

/**
 * Import the shipped executor module.
 *
 * Two paths, because it depends on which Node runs the suite:
 *   1. Electron's own Node (`runtime/bin/node`) has an asar-aware loader, so the
 *      archive URL imports directly — the exact bytes the Host is executing.
 *   2. Plain Node cannot read an archive, so the package is extracted first. Its
 *      dependencies (`schemastery`, `zod`) then resolve from the profile.
 *
 * @returns the module namespace, or `null` when this machine has no such
 *   installation (a contributing test should skip there, not fail).
 */
export async function loadShippedExecutor() {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    cached = await import(ASAR_ENTRY);
    return cached;
  } catch {
    // Fall through to extraction.
  }
  try {
    const handle = await open(ASAR, 'r');
    try {
      const { entries, baseOffset } = await readAsarIndex(handle);
      const wanted = [...entries].filter(([name]) => name === PREFIX || name.startsWith(`${PREFIX}/`));
      if (wanted.length === 0) return null;
      const dir = await mkdtemp(path.join(tmpdir(), 'dsh-llm-retry-'));
      for (const [name, entry] of wanted) {
        const target = path.join(dir, name.slice(PREFIX.length + 1));
        await mkdir(path.dirname(target), { recursive: true });
        const buffer = Buffer.alloc(entry.size);
        if (entry.size > 0) {
          await handle.read(buffer, 0, entry.size, baseOffset + Number(entry.offset));
        }
        await writeFile(target, buffer);
      }
      cached = await import(path.join(dir, 'lib/index.js'));
      return cached;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
