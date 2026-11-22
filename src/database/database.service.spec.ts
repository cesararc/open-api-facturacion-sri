import { ConfigService } from '@nestjs/config';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const poolInstances: any[] = [];
let connectImpl: () => Promise<any>;

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((options: any) => {
    const instance = {
      options,
      on: jest.fn(),
      connect: jest.fn(() => connectImpl()),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };
    poolInstances.push(instance);
    return instance;
  }),
}));

import { DatabaseService } from './database.service';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

function buildService(db: Record<string, any>): DatabaseService {
  const values: Record<string, any> = {
    'database.host': 'localhost',
    'database.port': 5432,
    'database.name': 'db',
    'database.user': 'u',
    'database.password': 'p',
    'database.ssl': 'false',
    'database.sslRejectUnauthorized': true,
    'database.sslCa': '',
    ...db,
  };
  const config = {
    get: jest.fn((key: string, def?: any) =>
      key in values ? values[key] : def,
    ),
  } as unknown as ConfigService;
  return new DatabaseService(config);
}

describe('DatabaseService', () => {
  beforeEach(() => {
    poolInstances.length = 0;
    connectImpl = async () => ({ release: jest.fn() });
  });

  describe('arranque', () => {
    it('arranca cuando la conexión funciona', async () => {
      const service = buildService({});

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(poolInstances).toHaveLength(1);
    });

    it('NO arranca si no puede conectarse: propaga el error', async () => {
      connectImpl = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      };
      const service = buildService({});

      await expect(service.onModuleInit()).rejects.toThrow('ECONNREFUSED');
    });

    it('cierra el pool que no pudo conectarse', async () => {
      connectImpl = async () => {
        throw new Error('timeout');
      };
      const service = buildService({});

      await expect(service.onModuleInit()).rejects.toThrow('timeout');

      expect(poolInstances[0].end).toHaveBeenCalled();
    });
  });

  describe('TLS', () => {
    const sslDe = async (db: Record<string, any>) => {
      await buildService(db).onModuleInit();
      return poolInstances[0].options.ssl;
    };

    it('DB_SSL=false: sin TLS', async () => {
      expect(await sslDe({ 'database.ssl': 'false' })).toBeUndefined();
    });

    it('DB_SSL=true: verifica el certificado del servidor por defecto', async () => {
      expect(await sslDe({ 'database.ssl': 'true' })).toEqual({
        rejectUnauthorized: true,
      });
    });

    it('DB_SSL_REJECT_UNAUTHORIZED=false: cifra sin verificar, solo si se pide', async () => {
      expect(
        await sslDe({
          'database.ssl': 'true',
          'database.sslRejectUnauthorized': false,
        }),
      ).toEqual({ rejectUnauthorized: false });
    });

    it('DB_SSL_CA con contenido PEM: se usa como CA', async () => {
      expect(
        await sslDe({ 'database.ssl': 'true', 'database.sslCa': PEM }),
      ).toEqual({ rejectUnauthorized: true, ca: PEM });
    });

    it('DB_SSL_CA con \\n literales (variable de entorno en una línea)', async () => {
      const enUnaLinea = PEM.replace(/\n/g, '\\n');

      const ssl = await sslDe({
        'database.ssl': 'true',
        'database.sslCa': enUnaLinea,
      });

      expect(ssl.ca).toBe(PEM);
    });

    it('DB_SSL_CA con una ruta: lee el archivo', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'db-ca-'));
      const caPath = join(dir, 'ca.pem');
      writeFileSync(caPath, PEM);

      try {
        const ssl = await sslDe({
          'database.ssl': 'true',
          'database.sslCa': caPath,
        });
        expect(ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('DB_SSL_CA con una ruta inexistente: no arranca', async () => {
      const service = buildService({
        'database.ssl': 'true',
        'database.sslCa': '/no/existe/ca.pem',
      });

      await expect(service.onModuleInit()).rejects.toThrow(
        'DB_SSL_CA apunta a un archivo que no existe',
      );
    });

    it('DB_SSL=false ignora DB_SSL_CA', async () => {
      expect(
        await sslDe({ 'database.ssl': 'false', 'database.sslCa': PEM }),
      ).toBeUndefined();
    });
  });
});
