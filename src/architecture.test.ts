import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(path, entry.name);
    return entry.isDirectory() ? files(file) : file.endsWith('.ts') ? [file] : [];
  });
}
const sources = files(resolve(root, 'src'));
function imports(path: string) {
  return [...readFileSync(path, 'utf8').matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)].map(match => match[1]!);
}
test('active imports resolve locally and never reach the archive', () => {
  for (const file of sources) for (const specifier of imports(file)) {
    if (!specifier.startsWith('.')) continue;
    const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
    assert(!relative(root, target).startsWith('legacy' + sep), `${relative(root, file)} imports archive ${specifier}`);
    assert(existsSync(target), `${relative(root, file)} has an unresolved import: ${specifier}`);
  }
});
test('execution core and capabilities cannot depend on service storage, channels or provider infrastructure', () => {
  for (const file of sources.filter(file => /[/\\](agent|capabilities)[/\\]/.test(file) && !file.endsWith('.test.ts'))) {
    for (const specifier of imports(file)) {
      assert(specifier.startsWith('.'), `unexpected external core dependency: ${specifier}`);
      const target = relative(resolve(root, 'src'), resolve(dirname(file), specifier));
      assert(/^(agent|capabilities|shared)[/\\]/.test(target), `core dependency crosses boundary: ${target}`);
    }
  }
});
test('default scripts and compiler scope exclude legacy entry points', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dev, pkg.scripts['agent:serve']);
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert(!/napcat|bot:|replay|memes:/.test(name), `legacy command exposed: ${name}`);
    assert(!/legacy\//.test(String(command)), `default command reaches archive: ${name}`);
  }
  assert.equal(pkg.dependencies.ws, undefined); assert.equal(pkg.dependencies.sharp, undefined);
  const config = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8'));
  assert.deepEqual(config.include, ['src/**/*.ts']); assert(config.exclude.includes('legacy'));
});
