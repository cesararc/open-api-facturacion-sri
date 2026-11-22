import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { basename } from 'path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiConsumes,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import {
  CertificateService,
  CertificateValidation,
} from './certificate.service';
import {
  UploadCertificateDto,
  ValidateCertificateDto,
} from './dto/certificate.dto';
import { DatabaseService } from '../../database';
import { EncryptionService } from '../../common/services/encryption.service';
import { XmlSignerService } from '../sri/services/xml-signer.service';
import { SriRepositoryService } from '../sri/services/sri-repository.service';
import { EmisoresService } from '../emisores/emisores.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload, UserRole } from '../auth/dto/auth.dto';

@ApiTags('Certificates')
@ApiBearerAuth('JWT')
@Controller('certificates')
export class CertificateController {
  private readonly logger = new Logger(CertificateController.name);

  constructor(
    private readonly certificateService: CertificateService,
    private readonly db: DatabaseService,
    private readonly encryptionService: EncryptionService,
    private readonly xmlSignerService: XmlSignerService,
    private readonly emisoresService: EmisoresService,
    private readonly eventEmitter: EventEmitter2,
    private readonly sriRepository: SriRepositoryService,
  ) {}

  private assertValidFileName(fileName: string): void {
    if (
      !fileName ||
      !fileName.toLowerCase().endsWith('.p12') ||
      basename(fileName) !== fileName
    ) {
      throw new BadRequestException(
        'Nombre de archivo inválido. Debe tener extensión .p12',
      );
    }
  }

  /**
   * Un certificado solo es visible para el tenant del emisor al que está
   * vinculado. Responde 404 (no 403) para no confirmar que el archivo existe.
   */
  private async assertCertificateAccess(
    fileName: string,
    user: JwtPayload,
  ): Promise<void> {
    if (user.rol === UserRole.SUPERADMIN) return;

    const owner = user.tenantId
      ? await this.db.queryOne<{ id: string }>(
          `SELECT id FROM emisores
           WHERE certificado_nombre = $1 AND tenant_id = $2 LIMIT 1`,
          [fileName, user.tenantId],
        )
      : null;

    if (!owner) {
      throw new NotFoundException(`El certificado ${fileName} no existe`);
    }
  }

  /**
   * Tras cambiar el certificado de un emisor: descarta la clave ya cargada en
   * memoria y la fila cacheada, para que la siguiente emisión use lo nuevo.
   */
  private async invalidateCertificateCaches(ruc: string): Promise<void> {
    this.xmlSignerService.clearEmisorCache(ruc);
    await this.sriRepository.invalidateEmisorCache(ruc);
  }

  /**
   * GET /certificates/list-certs
   * List available certificates
   */
  @Get('list-certs')
  @ApiOperation({ summary: 'Listar certificados disponibles' })
  @ApiQuery({ name: 'page', required: false, description: 'Número de página' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Elementos por página',
  })
  @ApiResponse({ status: 200, description: 'Lista de certificados' })
  async listCertificates(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const options: { page?: number; limit?: number } = {};
    if (page) options.page = parseInt(page);
    if (limit) options.limit = parseInt(limit);

    const isSuperAdmin = user.rol === UserRole.SUPERADMIN;
    const allCerts = this.certificateService.listAllCertificates();

    // Emisores vinculados a esos archivos; un usuario normal solo ve los de su tenant
    type EmisorCert = {
      certificado_nombre: string;
      ruc: string;
      razon_social: string;
      certificado_valido_hasta: Date | null;
      certificado_sujeto: string | null;
    };
    let emisores: EmisorCert[] = [];
    if (allCerts.length > 0 && (isSuperAdmin || user.tenantId)) {
      const params: unknown[] = [allCerts.map((cert) => cert.name)];
      const tenantFilter = isSuperAdmin
        ? ''
        : `AND tenant_id = $${params.push(user.tenantId)}`;
      emisores = await this.db.queryAll<EmisorCert>(
        `SELECT certificado_nombre, ruc, razon_social,
                certificado_valido_hasta, certificado_sujeto
         FROM emisores
         WHERE certificado_nombre = ANY($1) ${tenantFilter}`,
        params as any[],
      );
    }
    const emisorPorArchivo = new Map<string, EmisorCert>();
    for (const emisor of emisores) {
      if (!emisorPorArchivo.has(emisor.certificado_nombre)) {
        emisorPorArchivo.set(emisor.certificado_nombre, emisor);
      }
    }

    const visibles = allCerts
      .filter((cert) => isSuperAdmin || emisorPorArchivo.has(cert.name))
      .map((cert) => {
        const emisor = emisorPorArchivo.get(cert.name);
        return {
          ...cert,
          emisorRuc: emisor?.ruc || null,
          emisorRazonSocial: emisor?.razon_social || null,
          validoHasta: emisor?.certificado_valido_hasta || null,
          sujeto: emisor?.certificado_sujeto || null,
        };
      });

    const result = this.certificateService.paginateCertificates(
      visibles,
      options,
    );

    return {
      success: true,
      data: {
        certificates: result.certificates,
        total: result.total,
        pagination: result.pagination,
      },
    };
  }

  /**
   * DELETE /certificates/delete-cert/:fileName
   * Delete a certificate
   */
  @Delete('delete-cert/:fileName')
  @ApiOperation({ summary: 'Eliminar un certificado' })
  @ApiParam({ name: 'fileName', description: 'Nombre del archivo .p12' })
  @ApiResponse({ status: 200, description: 'Certificado eliminado' })
  @ApiResponse({ status: 404, description: 'Certificado no encontrado' })
  async deleteCertificate(
    @Param('fileName') fileName: string,
    @CurrentUser() user: JwtPayload,
  ) {
    this.assertValidFileName(fileName);

    const isSuperAdmin = user.rol === UserRole.SUPERADMIN;
    const existeEnDisco = this.certificateService.certificateExists(fileName);

    if (isSuperAdmin) {
      const vinculado = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM emisores WHERE certificado_nombre = $1 LIMIT 1`,
        [fileName],
      );
      // El .p12 vive en la BD: puede estar vinculado aunque falte el archivo
      if (!existeEnDisco && !vinculado) {
        throw new NotFoundException(`El certificado ${fileName} no existe`);
      }
    } else {
      await this.assertCertificateAccess(fileName, user);
    }

    // Limpiar datos del certificado solo en los emisores del tenant que lo pide
    const cleanParams: unknown[] = [fileName];
    const tenantFilter = isSuperAdmin
      ? ''
      : `AND tenant_id = $${cleanParams.push(user.tenantId)}`;

    const cleanResult = await this.db.query(
      `UPDATE emisores SET
        certificado_p12 = NULL,
        certificado_password = NULL,
        certificado_password_encrypted = NULL,
        certificado_valido_hasta = NULL,
        certificado_sujeto = NULL,
        certificado_nombre = NULL,
        certificado_updated_at = NULL,
        updated_at = NOW()
       WHERE certificado_nombre = $1 ${tenantFilter}
       RETURNING id, ruc`,
      cleanParams as any[],
    );

    for (const row of cleanResult.rows) {
      await this.invalidateCertificateCaches(row.ruc);
    }

    // Eliminar el archivo físico solo si ya ningún emisor lo usa
    const sigueEnUso = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM emisores WHERE certificado_nombre = $1 LIMIT 1`,
      [fileName],
    );
    if (existeEnDisco && !sigueEnUso) {
      this.certificateService.deleteCertificate(fileName);
    }

    const emisoresLimpiados = cleanResult.rows.length;
    this.logger.log(
      `Certificado ${fileName} eliminado. Emisores actualizados: ${emisoresLimpiados}`,
    );

    this.eventEmitter.emit('certificado.eliminado', {
      fileName,
      emisoresActualizados: emisoresLimpiados,
    });

    return {
      success: true,
      data: {
        message: `Certificado ${fileName} eliminado correctamente`,
        emisoresActualizados: emisoresLimpiados,
        emisores: cleanResult.rows,
      },
    };
  }

  /**
   * POST /certificates/upload-cert
   * Upload a P12 certificate with validation
   */
  @Post('upload-cert')
  @ApiOperation({ summary: 'Subir certificado P12 con validación' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        cert: { type: 'string', format: 'binary' },
        password: { type: 'string' },
        ruc: { type: 'string', example: '0924383631001' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Certificado subido y validado' })
  @ApiResponse({ status: 400, description: 'Certificado inválido' })
  @UseInterceptors(
    FileInterceptor('cert', {
      // En memoria: el archivo solo se guarda después de validar el acceso al
      // emisor, la contraseña y la vigencia. Así una subida fallida nunca pisa
      // ni borra el certificado de otro negocio.
      storage: memoryStorage(),
      fileFilter: (req, file, cb) => {
        if (file.originalname.toLowerCase().endsWith('.p12')) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException('Solo se permiten archivos .p12') as any,
            false,
          );
        }
      },
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    }),
  )
  async uploadCertificate(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadCertificateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!file) {
      throw new BadRequestException('No se proporcionó ningún archivo');
    }

    const { password, ruc } = body;

    if (!password) {
      throw new BadRequestException(
        'Se requiere la contraseña del certificado para validar su vigencia',
      );
    }

    if (!ruc) {
      throw new BadRequestException(
        'El RUC del emisor es obligatorio para vincular el certificado',
      );
    }

    // Validar acceso tenant antes de procesar
    const emisor = await this.emisoresService.validateRucAccess(ruc, user);

    // Un archivo por emisor: dos negocios con "firma.p12" ya no se pisan
    const fileName = `${emisor.ruc}.p12`;

    let validation: CertificateValidation;
    try {
      validation = this.certificateService.validateCertificateBuffer(
        file.buffer,
        password,
        fileName,
      );
    } catch (error) {
      throw new BadRequestException(
        `Error al validar el certificado: ${(error as Error).message}. Verifique la contraseña.`,
      );
    }

    if (!validation.isValid) {
      throw new BadRequestException({
        message: `Certificado no válido: ${validation.reason}`,
        validationDetails: {
          isExpired: validation.isExpired,
          isNotYetValid: validation.isNotYetValid,
          expiryDate: validation.expiryDate,
          startDate: validation.startDate,
        },
      });
    }

    // Vincular al emisor: la BD es la fuente del .p12 para firmar
    const bindingResult = await this.bindCertificateToEmisor(
      emisor.id,
      emisor.ruc,
      fileName,
      password,
      validation.expiryDate,
      validation.subject?.commonName || '',
      file.buffer,
    );

    if (!bindingResult.success) {
      // Sin vínculo no hay certificado guardado en ningún lado: no es un éxito
      this.logger.error(
        `No se pudo vincular certificado al emisor RUC ${ruc}: ${bindingResult.message}`,
      );
      throw new InternalServerErrorException(
        'No se pudo guardar el certificado. Intente nuevamente.',
      );
    }

    // Copia en disco como respaldo; si falla, la firma sigue saliendo de la BD
    try {
      this.certificateService.saveCertificateFile(fileName, file.buffer);
    } catch (error) {
      this.logger.warn(
        `Certificado guardado en BD pero no en disco (${fileName}): ${(error as Error).message}`,
      );
    }

    this.logger.log(`Certificado ${fileName} vinculado al emisor RUC: ${ruc}`);

    this.eventEmitter.emit('certificado.subido', {
      fileName,
      size: file.size,
      subject: validation.subject?.commonName || '',
      tenantId: user.tenantId,
    });

    const response: any = {
      success: true,
      data: {
        message: 'Certificado subido y validado correctamente',
        fileName,
        size: file.size,
        uploadedAt: new Date().toISOString(),
        validation: {
          isValid: validation.isValid,
          expiryDate: validation.expiryDate,
          daysUntilExpiry: validation.daysUntilExpiry,
          subject: validation.subject,
        },
        emisorBinding: {
          ruc: ruc,
          message: 'Certificado vinculado al emisor correctamente',
        },
      },
    };

    // Add warning if certificate expires soon
    if (validation.warning) {
      response.data.warning = validation.warning;
    }

    return response;
  }

  /**
   * Encrypt password using EncryptionService
   */
  private async encryptPassword(password: string): Promise<string> {
    return this.encryptionService.encrypt(password);
  }

  /**
   * Decrypt password using EncryptionService
   */
  async decryptPassword(encryptedPassword: string): Promise<string> {
    return this.encryptionService.decrypt(encryptedPassword);
  }

  /**
   * Bind certificate to emisor in database
   */
  private async bindCertificateToEmisor(
    emisorId: string,
    ruc: string,
    fileName: string,
    password: string,
    expiryDate: Date,
    subject: string,
    p12Buffer: Buffer,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const anterior = await this.db.queryOne<{
        certificado_nombre: string | null;
      }>('SELECT certificado_nombre FROM emisores WHERE id = $1', [emisorId]);

      if (!anterior) {
        return { success: false, message: `No existe emisor con RUC ${ruc}` };
      }

      // Encrypt password
      const encryptedPassword = await this.encryptPassword(password);

      // Update emisor with certificate info including the binary P12.
      // Por id y no por RUC: solo el emisor cuyo acceso ya se validó.
      await this.db.query(
        `UPDATE emisores SET 
          certificado_nombre = $1,
          certificado_password_encrypted = $2,
          certificado_valido_hasta = $3,
          certificado_sujeto = $4,
          certificado_p12 = $5,
          certificado_updated_at = NOW()
        WHERE id = $6`,
        [fileName, encryptedPassword, expiryDate, subject, p12Buffer, emisorId],
      );

      // FIX P4: Invalidar caché del certificado en XmlSignerService
      // para forzar la carga del nuevo P12 en la próxima firma
      await this.invalidateCertificateCaches(ruc);
      this.logger.log(`Caché de certificado invalidado para RUC: ${ruc}`);

      await this.removeOrphanCertificateFile(
        anterior.certificado_nombre,
        fileName,
      );

      return { success: true, message: 'Certificado vinculado correctamente' };
    } catch (error) {
      this.logger.error(
        `Error al vincular certificado: ${(error as Error).message}`,
      );
      return { success: false, message: (error as Error).message };
    }
  }

  /**
   * Al reemplazar un certificado, borra el archivo anterior del emisor si
   * tenía otro nombre y ningún otro emisor lo sigue usando.
   */
  private async removeOrphanCertificateFile(
    previousName: string | null,
    currentName: string,
  ): Promise<void> {
    if (!previousName || previousName === currentName) return;

    try {
      const sigueEnUso = await this.db.queryOne<{ id: string }>(
        'SELECT id FROM emisores WHERE certificado_nombre = $1 LIMIT 1',
        [previousName],
      );
      if (
        !sigueEnUso &&
        this.certificateService.certificateExists(previousName)
      ) {
        this.certificateService.deleteCertificate(previousName);
      }
    } catch (error) {
      this.logger.warn(
        `No se pudo limpiar el certificado anterior ${previousName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * GET /certificates/cert-info/:fileName
   * Get certificate info
   */
  @Get('cert-info/:fileName')
  @ApiOperation({ summary: 'Obtener información de un certificado' })
  @ApiParam({ name: 'fileName', description: 'Nombre del archivo .p12' })
  @ApiResponse({ status: 200, description: 'Información del certificado' })
  async getCertificateInfo(
    @Param('fileName') fileName: string,
    @CurrentUser() user: JwtPayload,
  ) {
    this.assertValidFileName(fileName);
    await this.assertCertificateAccess(fileName, user);

    const certInfo = this.certificateService.getCertificateInfo(fileName);

    return {
      success: true,
      data: certInfo,
    };
  }

  /**
   * POST /certificates/validate-cert/:fileName
   * Validate an existing certificate with password
   */
  @Post('validate-cert/:fileName')
  @ApiOperation({ summary: 'Validar certificado existente' })
  @ApiParam({ name: 'fileName', description: 'Nombre del archivo .p12' })
  @ApiResponse({ status: 200, description: 'Resultado de validación' })
  async validateCertificate(
    @Param('fileName') fileName: string,
    @Body() body: ValidateCertificateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    this.assertValidFileName(fileName);
    await this.assertCertificateAccess(fileName, user);

    const { password } = body;

    if (!password) {
      throw new BadRequestException(
        'Se requiere la contraseña del certificado',
      );
    }

    let validation;
    try {
      validation = this.certificateService.validateCertificateExpiry(
        fileName,
        password,
      );
    } catch (error) {
      throw new BadRequestException(
        `No se pudo validar el certificado. Verifique la contraseña. ${error.message || ''}`,
      );
    }

    const response: any = {
      success: true,
      data: {
        fileName: fileName,
        validation: validation,
      },
    };

    // If certificate is not valid, change response status
    if (!validation.isValid) {
      response.success = false;
      response.error = validation.reason;
      throw new BadRequestException(response);
    }

    return response;
  }
}
