import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

let cached: string | undefined;

/**
 * Versión de la API. La única fuente es `version` en package.json: Swagger y
 * cualquier otro lugar que la muestre deben leerla de aquí.
 *
 * Busca package.json subiendo desde este archivo, así funciona igual desde
 * `src/` (tests, ts-node) que desde `dist/` (producción).
 */
export function getAppVersion(): string {
  if (cached) return cached;

  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === 'open-api-facturacion-sri' && pkg.version) {
          cached = pkg.version;
          return cached;
        }
      } catch {
        // package.json ilegible: seguir subiendo
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cached = '0.0.0';
  return cached;
}
