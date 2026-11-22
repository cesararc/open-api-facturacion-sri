import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  let service: EncryptionService;
  let configService: jest.Mocked<ConfigService>;

  const validKey = 'my-secret-encryption-key-32b';
  const validSalt = 'my-salt-value';

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        EncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'encryptionKey') return validKey;
              if (key === 'encryptionSalt') return validSalt;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(EncryptionService);
    configService = module.get(ConfigService);
  });

  // ─── Inicialización ────────────────────────────────────────────────────

  describe('inicialización', () => {
    it('debe inicializar correctamente con ENCRYPTION_KEY y ENCRYPTION_SALT', () => {
      expect(service).toBeDefined();
      expect(configService.get).toHaveBeenCalledWith('encryptionKey');
      expect(configService.get).toHaveBeenCalledWith('encryptionSalt');
    });

    it('debe lanzar error si ENCRYPTION_KEY no está definida', async () => {
      await expect(
        Test.createTestingModule({
          providers: [
            EncryptionService,
            {
              provide: ConfigService,
              useValue: {
                get: jest.fn((key: string) => {
                  if (key === 'encryptionKey') return undefined;
                  if (key === 'encryptionSalt') return validSalt;
                  return undefined;
                }),
              },
            },
          ],
        }).compile(),
      ).rejects.toThrow('ENCRYPTION_KEY y ENCRYPTION_SALT son requeridas');
    });

    it('debe lanzar error si ENCRYPTION_SALT no está definida', async () => {
      await expect(
        Test.createTestingModule({
          providers: [
            EncryptionService,
            {
              provide: ConfigService,
              useValue: {
                get: jest.fn((key: string) => {
                  if (key === 'encryptionKey') return validKey;
                  if (key === 'encryptionSalt') return undefined;
                  return undefined;
                }),
              },
            },
          ],
        }).compile(),
      ).rejects.toThrow('ENCRYPTION_KEY y ENCRYPTION_SALT son requeridas');
    });

    it('debe lanzar error si ambas env vars están ausentes', async () => {
      await expect(
        Test.createTestingModule({
          providers: [
            EncryptionService,
            {
              provide: ConfigService,
              useValue: {
                get: jest.fn(() => undefined),
              },
            },
          ],
        }).compile(),
      ).rejects.toThrow('ENCRYPTION_KEY y ENCRYPTION_SALT son requeridas');
    });
  });

  // ─── encrypt ───────────────────────────────────────────────────────────

  describe('encrypt', () => {
    it('debe encriptar texto plano y retornar formato v2:iv:tag:encrypted (GCM)', async () => {
      const plainText = 'password-secreto-123';
      const encrypted = await service.encrypt(plainText);

      expect(encrypted).toMatch(/^v2:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
      const [version, ivHex, tagHex, encryptedHex] = encrypted.split(':');
      expect(version).toBe('v2');
      expect(ivHex).toHaveLength(24); // 12 bytes IV (GCM) = 24 hex chars
      expect(tagHex).toHaveLength(32); // 16 bytes de tag = 32 hex chars
      // GCM no rellena: el cifrado mide lo mismo que el texto
      expect(encryptedHex).toHaveLength(plainText.length * 2);
      expect(service.isCurrentFormat(encrypted)).toBe(true);
    });

    it('debe generar IVs diferentes en cada encriptación (aleatoriedad)', async () => {
      const plainText = 'mismo-texto';
      const enc1 = await service.encrypt(plainText);
      const enc2 = await service.encrypt(plainText);

      expect(enc1).not.toBe(enc2);
      // El IV debe ser diferente
      expect(enc1.split(':')[1]).not.toBe(enc2.split(':')[1]);
    });

    it('debe encriptar y recuperar strings vacíos', async () => {
      const encrypted = await service.encrypt('');

      expect(encrypted).toMatch(/^v2:[0-9a-f]{24}:[0-9a-f]{32}:$/);
      expect(await service.decrypt(encrypted)).toBe('');
    });

    it('debe encriptar caracteres especiales y unicode', async () => {
      const plainText = 'contraseñañüé@#$%^&*()';
      const encrypted = await service.encrypt(plainText);
      const decrypted = await service.decrypt(encrypted);

      expect(decrypted).toBe(plainText);
    });

    it('debe encriptar strings largos', async () => {
      const plainText = 'A'.repeat(10000);
      const encrypted = await service.encrypt(plainText);
      const decrypted = await service.decrypt(encrypted);

      expect(decrypted).toBe(plainText);
    });
  });

  // ─── decrypt ───────────────────────────────────────────────────────────

  describe('decrypt', () => {
    it('debe desencriptar correctamente texto previamente encriptado', async () => {
      const plainText = 'mi-password-secreto';
      const encrypted = await service.encrypt(plainText);
      const decrypted = await service.decrypt(encrypted);

      expect(decrypted).toBe(plainText);
    });

    it('debe lanzar error si el formato no es iv:encrypted', async () => {
      await expect(service.decrypt('formato-invalido')).rejects.toThrow(
        'Formato de texto encriptado inválido',
      );
    });

    it('debe lanzar error si falta la parte encrypted', async () => {
      await expect(service.decrypt('abc123')).rejects.toThrow(
        'Formato de texto encriptado inválido',
      );
    });

    it('debe lanzar error si el IV no es hex válido', async () => {
      await expect(
        service.decrypt('no-hex:abc123'),
      ).rejects.toThrow();
    });

    it('debe poder desencriptar múltiples valores en secuencia', async () => {
      const texts = ['uno', 'dos', 'tres'];
      const encrypted = await Promise.all(texts.map((t) => service.encrypt(t)));
      const decrypted = await Promise.all(encrypted.map((e) => service.decrypt(e)));

      expect(decrypted).toEqual(texts);
    });
  });

  // ─── Compatibilidad con lo ya guardado (AES-256-CBC) ───────────────────

  describe('valores guardados con el formato anterior (CBC)', () => {
    // Generados con la implementación anterior de este servicio y la misma
    // ENCRYPTION_KEY / ENCRYPTION_SALT de esta spec. Son el contrato: las
    // contraseñas de certificados ya guardadas en producción tienen esta forma.
    const guardados = [
      {
        plain: 'MyCertP@ssw0rd!2026',
        cbc: 'e777854047117b8dda8a4572a894a4e1:9950401de3e4597956fe1a17c3ddfaf581e0c56dbbc506f29cd5ca235a1de464',
      },
      {
        plain: 'contraseñañüé@#$%^&*()',
        cbc: '39d8b6436c89dc53a3f2501770ea77d6:f0269843ebe60ad369ea50cba8f3775f5d8f1aff72416fadb27c1f091295a041',
      },
    ];

    it.each(guardados)('sigue desencriptando "$plain"', async ({ plain, cbc }) => {
      expect(service.isCurrentFormat(cbc)).toBe(false);
      expect(await service.decrypt(cbc)).toBe(plain);
    });

    it('al volver a guardar el valor queda en el formato nuevo', async () => {
      const plain = await service.decrypt(guardados[0].cbc);
      const reencriptado = await service.encrypt(plain);

      expect(service.isCurrentFormat(reencriptado)).toBe(true);
      expect(await service.decrypt(reencriptado)).toBe(guardados[0].plain);
    });
  });

  // ─── Integridad (GCM) ──────────────────────────────────────────────────

  describe('integridad del formato v2', () => {
    const flipLastHexChar = (hex: string) =>
      hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');

    it('rechaza un valor cuyo contenido fue alterado', async () => {
      const [v, iv, tag, data] = (await service.encrypt('clave-del-p12')).split(':');
      const alterado = [v, iv, tag, flipLastHexChar(data)].join(':');

      await expect(service.decrypt(alterado)).rejects.toThrow();
    });

    it('rechaza un valor cuyo tag fue alterado', async () => {
      const [v, iv, tag, data] = (await service.encrypt('clave-del-p12')).split(':');
      const alterado = [v, iv, flipLastHexChar(tag), data].join(':');

      await expect(service.decrypt(alterado)).rejects.toThrow();
    });

    it('rechaza un tag recortado', async () => {
      const [v, iv, tag, data] = (await service.encrypt('clave-del-p12')).split(':');
      const recortado = [v, iv, tag.slice(0, 8), data].join(':');

      await expect(service.decrypt(recortado)).rejects.toThrow(
        'Formato de texto encriptado inválido',
      );
    });

    it('rechaza un v2 con partes de menos', async () => {
      await expect(service.decrypt('v2:abcdef')).rejects.toThrow(
        'Formato de texto encriptado inválido',
      );
    });

    it('no desencripta con otra ENCRYPTION_KEY', async () => {
      const encrypted = await service.encrypt('clave-del-p12');
      const otra = new EncryptionService({
        get: (key: string) =>
          key === 'encryptionKey' ? 'otra-clave-distinta' : validSalt,
      } as unknown as ConfigService);

      await expect(otra.decrypt(encrypted)).rejects.toThrow();
    });
  });

  // ─── Round-trip (encrypt → decrypt) ────────────────────────────────────

  describe('round-trip encrypt/decrypt', () => {
    it('debe mantener integridad del texto para passwords de certificados', async () => {
      const certPassword = 'MyCertP@ssw0rd!2026';
      const encrypted = await service.encrypt(certPassword);
      const decrypted = await service.decrypt(encrypted);

      expect(decrypted).toBe(certPassword);
    });

    it('debe funcionar con el mismo servicio instancia múltiples veces (key cache)', async () => {
      const text1 = 'password1';
      const text2 = 'password2';

      const enc1 = await service.encrypt(text1);
      const enc2 = await service.encrypt(text2);

      const dec1 = await service.decrypt(enc1);
      const dec2 = await service.decrypt(enc2);

      expect(dec1).toBe(text1);
      expect(dec2).toBe(text2);
    });
  });

  // ─── deriveKey cache (indirecto) ───────────────────────────────────────

  describe('deriveKey cache', () => {
    it('debe cachear la clave derivada (segunda encriptación no recalcula)', async () => {
      // Primera encriptación deriva y cachea la clave
      const enc1 = await service.encrypt('test1');
      expect(enc1).toBeDefined();

      // Segunda encriptación usa clave cacheada
      const enc2 = await service.encrypt('test2');
      expect(enc2).toBeDefined();

      // Ambas deben ser desencriptables con la misma instancia
      expect(await service.decrypt(enc1)).toBe('test1');
      expect(await service.decrypt(enc2)).toBe('test2');
    });
  });
});
