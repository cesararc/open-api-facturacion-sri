import { readFileSync } from 'fs';
import { join } from 'path';
import { getAppVersion } from './app-version';

const repoRoot = join(__dirname, '..', '..', '..');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

describe('versión única de la API', () => {
  const pkgVersion = (JSON.parse(read('package.json')) as { version: string })
    .version;

  it('getAppVersion devuelve la versión de package.json', () => {
    expect(getAppVersion()).toBe(pkgVersion);
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('package-lock.json lleva la misma versión', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };

    expect(lock.version).toBe(pkgVersion);
    expect(lock.packages[''].version).toBe(pkgVersion);
  });

  it('la entrada publicada más reciente del CHANGELOG es esa versión', () => {
    // Las entradas publicadas tienen fecha; las propuestas dicen "Propuesta"
    const publicadas = [
      ...read('CHANGELOG.md').matchAll(
        /^## \[(\d+\.\d+\.\d+)\] — \d{4}-\d{2}-\d{2}/gm,
      ),
    ].map((m) => m[1]);

    expect(publicadas[0]).toBe(pkgVersion);
  });

  it('Swagger no lleva una versión escrita a mano', () => {
    const main = read('src/main.ts');

    expect(main).toContain('.setVersion(getAppVersion())');
    expect(main).not.toMatch(/\.setVersion\(\s*['"`]/);
  });
});
