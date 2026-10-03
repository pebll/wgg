import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

/** Every relative import target (resolved) of a server-side file that points into ui/. */
function uiImports() {
  const found = [];
  for (const file of [...jsFiles(path.join(root, 'lib')), ...jsFiles(path.join(root, 'bin'))]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.relative(root, path.resolve(path.dirname(file), m[1]));
      if (target.startsWith('ui' + path.sep)) found.push({ file: path.relative(root, file), target });
    }
  }
  return found;
}

describe('#docker image contents', () => {
  it('the server only imports UI modules from ui/src/services, which the Dockerfile copies', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^COPY ui\/src\/services \.\/ui\/src\/services$/m);
    const outside = uiImports().filter(
      ({ target }) => !target.startsWith(path.join('ui', 'src', 'services') + path.sep),
    );
    expect(outside).toEqual([]);
  });

  it('the shared UI modules import nothing outside ui/src/services (no npm packages, no components)', () => {
    const dir = path.join(root, 'ui', 'src', 'services');
    const shared = new Set(uiImports().map(({ target }) => path.join(root, target)));
    for (const file of shared) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        expect(spec.startsWith('./'), `${path.relative(root, file)} imports ${spec}`).toBe(true);
        expect(path.resolve(path.dirname(file), spec).startsWith(dir)).toBe(true);
      }
    }
  });
});
