import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  ServiceUnavailableException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool | undefined;
  private readonly logger = new Logger(DatabaseService.name);

  // Regex para validar identificadores SQL (tablas, columnas)
  private static readonly SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    try {
      this.pool = new Pool({
        host: this.configService.get<string>('database.host'),
        port: this.configService.get<number>('database.port'),
        database: this.configService.get<string>('database.name'),
        user: this.configService.get<string>('database.user'),
        password: this.configService.get<string>('database.password'),
        ssl: this.buildSslOptions(),
        // Pool configurable desde .env
        max: this.configService.get<number>('DB_POOL_MAX', 10),
        idleTimeoutMillis: this.configService.get<number>(
          'DB_POOL_IDLE_TIMEOUT',
          30000,
        ),
        connectionTimeoutMillis: this.configService.get<number>(
          'DB_CONNECTION_TIMEOUT',
          10000,
        ),
        application_name: `open-api-facturacion-sri-${process.env.NODE_ENV ?? 'dev'}`,
      });

      // Listener de errores del pool
      this.pool.on('error', (err) => {
        this.logger.error(
          `Error inesperado en cliente idle del pool: ${err.message}`,
        );
      });

      // Test connection
      const client = await this.pool.connect();
      this.logger.log(
        '✅ Conexión a la base de datos establecida correctamente',
      );
      client.release();
    } catch (error) {
      // Sin base de datos la API no puede facturar ni autenticar: es mejor no
      // arrancar (y que el orquestador reinicie) que aceptar tráfico y fallar
      // en cada request.
      const message = (error as Error).message;
      this.logger.error(
        `❌ No se pudo conectar a la base de datos al arrancar: ${message}`,
      );
      if (/certificate|self.signed|unable to verify/i.test(message)) {
        this.logger.error(
          'El servidor PostgreSQL presentó un certificado que no se pudo verificar. ' +
            'Defina DB_SSL_CA con la CA del proveedor, o DB_SSL_REJECT_UNAUTHORIZED=false ' +
            'si acepta conectarse sin verificar el certificado.',
        );
      }
      await this.pool?.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  /**
   * Opciones TLS de la conexión.
   *
   * - DB_SSL=false (por defecto): sin TLS.
   * - DB_SSL=true: TLS verificando el certificado del servidor.
   *   - DB_SSL_CA: CA con la que verificar (contenido PEM o ruta a un archivo).
   *     Necesaria cuando el proveedor usa una CA propia.
   *   - DB_SSL_REJECT_UNAUTHORIZED=false: cifra pero no verifica quién está
   *     del otro lado. Solo para entornos donde no se puede obtener la CA.
   */
  private buildSslOptions():
    | { rejectUnauthorized: boolean; ca?: string }
    | undefined {
    if (this.configService.get('database.ssl') !== 'true') {
      return undefined;
    }

    const rejectUnauthorized =
      this.configService.get<boolean>('database.sslRejectUnauthorized') !==
      false;
    const ca = this.readSslCa(
      this.configService.get<string>('database.sslCa') || '',
    );

    if (!rejectUnauthorized) {
      this.logger.warn(
        'DB_SSL_REJECT_UNAUTHORIZED=false: la conexión a la base de datos va cifrada pero NO verifica el certificado del servidor',
      );
    }

    return ca ? { rejectUnauthorized, ca } : { rejectUnauthorized };
  }

  private readSslCa(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    // Contenido PEM directo (en una variable de entorno suele venir con \n literales)
    if (trimmed.includes('-----BEGIN')) {
      return trimmed.replace(/\\n/g, '\n');
    }
    // Si no, es una ruta
    if (!existsSync(trimmed)) {
      throw new Error(
        `DB_SSL_CA apunta a un archivo que no existe: ${trimmed}`,
      );
    }
    return readFileSync(trimmed, 'utf8');
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('Database connection pool closed');
    }
  }

  /**
   * Sanitiza identificadores SQL para prevenir inyección
   * Solo permite letras, números, guión bajo y punto (para schema.table)
   */
  private sanitizeIdentifier(identifier: string): string {
    if (!DatabaseService.SAFE_IDENTIFIER.test(identifier)) {
      throw new Error(
        `Identificador SQL no válido: "${identifier}". Solo se permiten letras, números, guión bajo y punto.`,
      );
    }
    return `"${identifier}"`;
  }

  /**
   * Execute a query with parameters
   * Guard explícito si el pool no está inicializado
   * Log seguro sin exponer SQL ni valores
   */
  async query<T extends QueryResultRow = any>(
    text: string,
    params?: any[],
  ): Promise<QueryResult<T>> {
    // Guard explícito con mensaje claro
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'La base de datos no está disponible. El pool de conexiones no fue inicializado correctamente. Verifica la variable DATABASE_URL y que PostgreSQL esté corriendo.',
      );
    }

    const start = Date.now();
    const operation = text.trim().split(/\s+/)[0].toUpperCase();
    const slowQueryThreshold = this.configService.get<number>(
      'DB_SLOW_QUERY_THRESHOLD_MS',
      1000,
    );

    try {
      const result = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;

      // Solo loguear operación y latencia — nunca el SQL crudo
      if (duration > slowQueryThreshold) {
        this.logger.warn(`[DB] ⚠️ Query lento: ${operation} → ${duration}ms`);
      } else {
        this.logger.debug(`[DB] ${operation} → ${duration}ms`);
      }

      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.logger.error(
        `[DB] ❌ ${operation} falló en ${duration}ms: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Execute a query and return the first row or null
   */
  async queryOne<T extends QueryResultRow = any>(
    text: string,
    params?: any[],
  ): Promise<T | null> {
    const result = await this.query<T>(text, params);
    return result.rows[0] || null;
  }

  /**
   * Execute a query and return all rows
   */
  async queryAll<T extends QueryResultRow = any>(
    text: string,
    params?: any[],
  ): Promise<T[]> {
    const result = await this.query<T>(text, params);
    return result.rows;
  }

  /**
   * Get a client from the pool for transactions
   */
  async getClient(): Promise<PoolClient> {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'La base de datos no está disponible.',
      );
    }
    return await this.pool.connect();
  }

  /**
   * Execute a transaction with automatic commit/rollback
   */
  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Insert a row and return the inserted row
   * Identificadores sanitizados
   */
  async insert<T extends QueryResultRow = any>(
    table: string,
    data: Record<string, any>,
    returning: string = '*',
  ): Promise<T | null> {
    if (!data || Object.keys(data).length === 0) {
      throw new Error(
        `No se proporcionaron datos para la operación en tabla "${table}"`,
      );
    }

    const keys = Object.keys(data);
    const values = Object.values(data);
    const safeTable = this.sanitizeIdentifier(table);
    const safeColumns = keys.map((k) => this.sanitizeIdentifier(k)).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

    const query = `INSERT INTO ${safeTable} (${safeColumns}) VALUES (${placeholders}) RETURNING ${returning}`;
    return this.queryOne<T>(query, values);
  }

  /**
   * Update rows and return the updated rows
   * Identificadores sanitizados
   * Opción strict para detectar updates silenciosos
   */
  async update<T extends QueryResultRow = any>(
    table: string,
    data: Record<string, any>,
    where: string,
    whereParams: any[],
    returning: string = '*',
    options?: { strict?: boolean },
  ): Promise<T[]> {
    if (!data || Object.keys(data).length === 0) {
      throw new Error(
        `No se proporcionaron datos para actualizar en tabla "${table}"`,
      );
    }

    const keys = Object.keys(data);
    const values = Object.values(data);
    const safeTable = this.sanitizeIdentifier(table);
    const setClause = keys
      .map((key, i) => `${this.sanitizeIdentifier(key)} = $${i + 1}`)
      .join(', ');
    const paramOffset = keys.length;

    // Adjust where params placeholders
    const adjustedWhere = where.replace(
      /\$(\d+)/g,
      (_, num) => `$${parseInt(num) + paramOffset}`,
    );

    const query = `UPDATE ${safeTable} SET ${setClause} WHERE ${adjustedWhere} RETURNING ${returning}`;
    const result = await this.query<T>(query, [...values, ...whereParams]);

    // Si strict=true y no se actualizó nada → lanzar error
    if (options?.strict && (result.rowCount ?? 0) === 0) {
      throw new NotFoundException(
        `No se encontró el registro a actualizar en "${table}" con los criterios proporcionados.`,
      );
    }

    return result.rows;
  }
}
