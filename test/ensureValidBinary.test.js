import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureBinary = vi.fn();
vi.mock('cloakbrowser', () => ({ ensureBinary: (...args) => ensureBinary(...args) }));

const { ensureValidBinary } = await import('../lib/services/ensureValidBinary.js');

let cache;
const touch = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
};

function install(version, files) {
  const dir = path.join(cache, `chromium-${version}`);
  for (const f of files) touch(path.join(dir, f));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'chrome');
}

beforeEach(() => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-bin-'));
  process.env.CLOAKBROWSER_CACHE_DIR = cache;
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  ensureBinary.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CLOAKBROWSER_CACHE_DIR;
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  fs.rmSync(cache, { recursive: true, force: true });
});

describe('ensureValidBinary', () => {
  it('pins and returns a complete installation', async () => {
    const bin = install('1.0.0', ['chrome', 'icudtl.dat', 'resources.pak']);
    ensureBinary.mockResolvedValue(bin);
    await expect(ensureValidBinary()).resolves.toBe(bin);
    expect(process.env.CLOAKBROWSER_BINARY_PATH).toBe(bin);
    expect(ensureBinary).toHaveBeenCalledTimes(1);
  });

  it('removes a broken installation and the version markers, then retries once', async () => {
    const broken = install('1.0.0', ['chrome', 'icudtl.dat']);
    touch(path.join(cache, 'latest_version'));
    touch(path.join(cache, 'latest_version_arm'));
    touch(path.join(cache, 'keep.txt'));
    const fresh = path.join(cache, 'chromium-1.0.1', 'chrome');
    ensureBinary.mockResolvedValueOnce(broken).mockImplementationOnce(async () => {
      for (const f of ['chrome', 'icudtl.dat', 'resources.pak']) touch(path.join(path.dirname(fresh), f));
      return fresh;
    });
    await expect(ensureValidBinary()).resolves.toBe(fresh);
    expect(fs.existsSync(path.dirname(broken))).toBe(false);
    expect(fs.existsSync(path.join(cache, 'latest_version'))).toBe(false);
    expect(fs.existsSync(path.join(cache, 'latest_version_arm'))).toBe(false);
    expect(fs.existsSync(path.join(cache, 'keep.txt'))).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('is missing: resources.pak'));
    expect(process.env.CLOAKBROWSER_BINARY_PATH).toBe(fresh);
  });

  it('throws when the re-download is still incomplete', async () => {
    const bin = install('2.0.0', ['chrome']);
    ensureBinary.mockImplementation(async () => {
      touch(bin);
      return bin;
    });
    await expect(ensureValidBinary()).rejects.toThrow(
      /still missing required files after re-download: icudtl\.dat, resources\.pak/,
    );
    expect(process.env.CLOAKBROWSER_BINARY_PATH).toBeUndefined();
  });

  it('works when the cache directory does not exist and propagates download errors', async () => {
    fs.rmSync(cache, { recursive: true, force: true });
    ensureBinary.mockRejectedValue(new Error('network down'));
    await expect(ensureValidBinary()).rejects.toThrow('network down');
  });

  it('checks the app bundle layout on macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const dir = path.join(cache, 'chromium-3.0.0');
    const bin = path.join(dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    touch(bin);
    touch(path.join(dir, 'Chromium.app', 'Contents', 'Info.plist'));
    fs.mkdirSync(path.join(dir, 'Chromium.app', 'Contents', 'Frameworks'));
    ensureBinary.mockResolvedValue(bin);
    await expect(ensureValidBinary()).resolves.toBe(bin);

    fs.rmSync(path.join(dir, 'Chromium.app', 'Contents', 'Frameworks'), { recursive: true });
    ensureBinary.mockImplementation(async () => bin);
    await expect(ensureValidBinary()).rejects.toThrow(/Frameworks/);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
