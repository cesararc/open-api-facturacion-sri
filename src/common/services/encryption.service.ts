import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

/**
 * Servicio centralizado de encriptación/desencriptación.
 *
 * Utiliza:
 * - ENCRYPTION_KEY (requerida): secreto del que se deriva la clave AES-256
 * - ENCRYPTION_SALT (requerida): salt para derivación de clave con scrypt
 *
 * Formatos:
 * - v2 (actual, AES-256-GCM):  "v2:iv_hex:tag_hex:encrypted_hex"
 *   GCM autentica el dato: si alguien altera lo guardado, decrypt() falla en
 *   vez de devolver basura.
 * - v1 (anterior, AES-256-CBC): "iv_hex:encrypted_hex"
 *   Solo lectura, para lo que ya estaba guardado. Se reescribe en v2 la
 *   próxima vez que ese valor se vuelva a guardar (p. ej. al subir de nuevo
 *   el certificado).
 */
@Injectable()
export class EncryptionService {
  private static readonly V2_PREFIX = 'v2';
  private static readonly GCM_IV_BYTES = 12;
  private static readonly GCM_TAG_BYTES = 16;

  private readonly logger = new Logger(EncryptionService.name);
  private readonly encryptionKey: string;
  private readonly encryptionSalt: string;
  private keyCache: Buffer | null = null;

  constructor(private readonly configService: ConfigService) {
    this.encryptionKey = this.configService.get<string>('encryptionKey')!;
    this.encryptionSalt = this.configService.get<string>('encryptionSalt')!;

    if (!this.encryptionKey || !this.encryptionSalt) {
      throw new Error(
        'ENCRYPTION_KEY y ENCRYPTION_SALT son requeridas. Defínelas en tu archivo .env',
      );
    }

    this.logger.log('EncryptionService inicializado correctamente');
  }

  /**
   * Deriva la clave de encriptación usando scrypt.
   * Cachea el resultado para evitar derivaciones repetidas.
   */
  private async deriveKey(): Promise<Buffer> {
    if (this.keyCache) {
      return this.keyCache;
    }

    const scryptAsync = promisify(scrypt);
    this.keyCache = (await scryptAsync(
      this.encryptionKey,
      this.encryptionSalt,
      32,
    )) as Buffer;

    return this.keyCache;
  }

  /**
   * Encripta un texto plano usando AES-256-GCM.
   * @param plainText - Texto a encriptar
   * @returns Texto encriptado en formato "v2:iv_hex:tag_hex:encrypted_hex"
   */
  async encrypt(plainText: string): Promise<string> {
    const iv = randomBytes(EncryptionService.GCM_IV_BYTES);
    const key = await this.deriveKey();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      EncryptionService.V2_PREFIX,
      iv.toString('hex'),
      tag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');
  }

  /**
   * Indica si un valor guardado ya usa el formato actual (v2 / GCM).
   */
  isCurrentFormat(encryptedText: string): boolean {
    return encryptedText.startsWith(`${EncryptionService.V2_PREFIX}:`);
  }

  /**
   * Desencripta un texto encriptado en formato v2 (GCM) o v1 (CBC).
   * @param encryptedText - "v2:iv:tag:encrypted" o "iv:encrypted"
   * @returns Texto plano original
   */
  async decrypt(encryptedText: string): Promise<string> {
    if (this.isCurrentFormat(encryptedText)) {
      return this.decryptGcm(encryptedText);
    }
    return this.decryptLegacyCbc(encryptedText);
  }

  private async decryptGcm(encryptedText: string): Promise<string> {
    const parts = encryptedText.split(':');
    const [, ivHex, tagHex, encryptedHex] = parts;

    // encryptedHex puede ser '' (texto vacío), por eso se valida la cantidad
    if (parts.length !== 4 || !ivHex || !tagHex) {
      throw new Error(
        'Formato de texto encriptado inválido. Se esperaba "v2:iv:tag:encrypted"',
      );
    }

    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    if (
      iv.length !== EncryptionService.GCM_IV_BYTES ||
      tag.length !== EncryptionService.GCM_TAG_BYTES
    ) {
      throw new Error('Formato de texto encriptado inválido (iv o tag)');
    }

    const key = await this.deriveKey();
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: EncryptionService.GCM_TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, 'hex')),
      decipher.final(), // lanza si el dato o el tag fueron alterados
    ]);

    return decrypted.toString('utf8');
  }

  private async decryptLegacyCbc(encryptedText: string): Promise<string> {
    const [ivHex, encryptedHex] = encryptedText.split(':');

    if (!ivHex || !encryptedHex) {
      throw new Error(
        'Formato de texto encriptado inválido. Se esperaba "iv:encrypted"',
      );
    }

    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const key = await this.deriveKey();
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }
}
