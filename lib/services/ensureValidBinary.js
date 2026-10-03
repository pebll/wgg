import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureBinary } from 'cloakbrowser';

const isMac = () => process.platform === 'darwin';

const cacheDir = () => process.env.CLOAKBROWSER_CACHE_DIR || path.join(os.homedir(), '.cloakbrowser');

/** Directory of the versioned installation (`chromium-X.Y.Z`) a binary belongs to. */
function installDir(binary) {
  const here = path.dirname(binary);
  // macOS: <install>/Chromium.app/Contents/MacOS/Chromium
  return isMac() ? path.resolve(here, '..', '..', '..') : here;
}

/** Names of the files an extracted installation must contain but does not. */
function missingParts(binary) {
  const here = path.dirname(binary);
  if (isMac()) {
    const contents = path.resolve(here, '..');
    return [
      ['Info.plist', path.join(contents, 'Info.plist')],
      ['Frameworks', path.join(contents, 'Frameworks')],
    ]
      .filter(([, location]) => !fs.existsSync(location))
      .map(([name]) => name);
  }
  return ['icudtl.dat', 'resources.pak'].filter((name) => !fs.existsSync(path.join(here, name)));
}

function wipeInstallation(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const cache = cacheDir();
  let entries = [];
  try {
    entries = fs.readdirSync(cache);
  } catch {
    // no cache directory yet: nothing to clean up
  }
  for (const entry of entries) {
    if (entry.startsWith('latest_version')) fs.rmSync(path.join(cache, entry), { force: true });
  }
}

/**
 * CloakBrowser only checks that the executable exists; an interrupted extraction can leave the rest of the
 * installation missing. Verify it, repair it once by re-downloading, and pin the result for launch().
 *
 * @returns {Promise<string>} path of a validated browser binary
 */
export async function ensureValidBinary() {
  let binary = await ensureBinary();
  let missing = missingParts(binary);

  if (missing.length > 0) {
    const dir = installDir(binary);
    console.warn(`[wgg] CloakBrowser installation at ${dir} is missing: ${missing.join(', ')}. Removing and retrying.`);
    wipeInstallation(dir);

    binary = await ensureBinary();
    missing = missingParts(binary);
    if (missing.length > 0) {
      throw new Error(
        `CloakBrowser binary at ${installDir(binary)} is still missing required files after re-download: ${missing.join(', ')}`,
      );
    }
  }

  process.env.CLOAKBROWSER_BINARY_PATH = binary;
  return binary;
}
