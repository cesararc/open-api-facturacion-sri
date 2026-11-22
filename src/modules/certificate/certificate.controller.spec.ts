import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CertificateController } from './certificate.controller';
import { JwtPayload, UserRole } from '../auth/dto/auth.dto';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const RUC = '0924383631001';

const userA: JwtPayload = {
  sub: 'user-a',
  email: 'a@test.com',
  rol: UserRole.ADMIN,
  tenantId: TENANT_A,
};
const superadmin: JwtPayload = {
  sub: 'root',
  email: 'root@test.com',
  rol: UserRole.SUPERADMIN,
  tenantId: null,
};

const validValidation = {
  isValid: true,
  isExpired: false,
  isNotYetValid: false,
  expiryDate: new Date('2030-01-01'),
  startDate: new Date('2024-01-01'),
  daysUntilExpiry: 900,
  subject: { commonName: 'NEGOCIO A', organization: 'O', country: 'EC' },
  issuer: { commonName: 'CA', organization: 'CA' },
};

function buildFile(originalname = 'firma.p12'): Express.Multer.File {
  return {
    originalname,
    buffer: Buffer.from('p12-bytes'),
    size: 9,
  } as Express.Multer.File;
}

describe('CertificateController', () => {
  let controller: CertificateController;
  let certificateService: any;
  let db: any;
  let encryptionService: any;
  let xmlSignerService: any;
  let emisoresService: any;
  let eventEmitter: any;
  let sriRepository: any;

  beforeEach(() => {
    certificateService = {
      validateCertificateBuffer: jest.fn().mockReturnValue(validValidation),
      saveCertificateFile: jest.fn(),
      certificateExists: jest.fn().mockReturnValue(true),
      deleteCertificate: jest.fn(),
      getCertificateInfo: jest.fn().mockReturnValue({ name: 'x.p12' }),
      validateCertificateExpiry: jest.fn().mockReturnValue(validValidation),
      listAllCertificates: jest.fn().mockReturnValue([]),
      paginateCertificates: jest.fn((certs: unknown[]) => ({
        certificates: certs,
        pagination: null,
        total: certs.length,
      })),
    };
    db = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      queryOne: jest.fn().mockResolvedValue(null),
      queryAll: jest.fn().mockResolvedValue([]),
    };
    encryptionService = {
      encrypt: jest.fn().mockResolvedValue('v2:cifrado'),
      decrypt: jest.fn(),
    };
    xmlSignerService = { clearEmisorCache: jest.fn() };
    emisoresService = {
      validateRucAccess: jest
        .fn()
        .mockResolvedValue({ id: 'emisor-a', ruc: RUC, tenantId: TENANT_A }),
    };
    eventEmitter = { emit: jest.fn() };
    sriRepository = {
      invalidateEmisorCache: jest.fn().mockResolvedValue(undefined),
    };

    controller = new CertificateController(
      certificateService,
      db,
      encryptionService,
      xmlSignerService,
      emisoresService,
      eventEmitter,
      sriRepository,
    );
  });

  describe('POST upload-cert', () => {
    const body = { password: 'clave', ruc: RUC };

    it('guarda el certificado como <ruc>.p12 sin importar el nombre original', async () => {
      db.queryOne.mockResolvedValueOnce({ certificado_nombre: null });

      const res = await controller.uploadCertificate(
        buildFile('firma.p12'),
        body,
        userA,
      );

      expect(res.data.fileName).toBe(`${RUC}.p12`);
      expect(certificateService.saveCertificateFile).toHaveBeenCalledWith(
        `${RUC}.p12`,
        expect.any(Buffer),
      );
    });

    it('vincula por id del emisor validado y guarda el binario en la BD', async () => {
      db.queryOne.mockResolvedValueOnce({ certificado_nombre: null });

      await controller.uploadCertificate(buildFile(), body, userA);

      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('certificado_p12 = $5');
      expect(sql).toContain('WHERE id = $6');
      expect(params).toEqual([
        `${RUC}.p12`,
        'v2:cifrado',
        validValidation.expiryDate,
        'NEGOCIO A',
        expect.any(Buffer),
        'emisor-a',
      ]);
    });

    it('invalida la clave en memoria y la fila cacheada del emisor', async () => {
      db.queryOne.mockResolvedValueOnce({ certificado_nombre: null });

      await controller.uploadCertificate(buildFile(), body, userA);

      expect(xmlSignerService.clearEmisorCache).toHaveBeenCalledWith(RUC);
      expect(sriRepository.invalidateEmisorCache).toHaveBeenCalledWith(RUC);
    });

    it('no escribe nada si la contraseña no abre el certificado', async () => {
      certificateService.validateCertificateBuffer.mockImplementation(() => {
        throw new Error('PKCS#12 MAC could not be verified');
      });

      await expect(
        controller.uploadCertificate(buildFile(), body, userA),
      ).rejects.toThrow(BadRequestException);

      expect(db.query).not.toHaveBeenCalled();
      expect(certificateService.saveCertificateFile).not.toHaveBeenCalled();
      expect(certificateService.deleteCertificate).not.toHaveBeenCalled();
    });

    it('rechaza un certificado vencido sin tocar BD ni disco', async () => {
      certificateService.validateCertificateBuffer.mockReturnValue({
        ...validValidation,
        isValid: false,
        isExpired: true,
        reason: 'Certificado expirado el 1/1/2020',
      });

      await expect(
        controller.uploadCertificate(buildFile(), body, userA),
      ).rejects.toThrow(BadRequestException);

      expect(db.query).not.toHaveBeenCalled();
      expect(certificateService.saveCertificateFile).not.toHaveBeenCalled();
    });

    it('no procesa el archivo si el emisor es de otro tenant', async () => {
      emisoresService.validateRucAccess.mockRejectedValue(
        new ForbiddenException('No tienes acceso a este emisor'),
      );

      await expect(
        controller.uploadCertificate(buildFile(), body, userA),
      ).rejects.toThrow(ForbiddenException);

      expect(
        certificateService.validateCertificateBuffer,
      ).not.toHaveBeenCalled();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('falla (no responde éxito) si no se pudo guardar en la BD', async () => {
      db.queryOne.mockResolvedValueOnce({ certificado_nombre: null });
      db.query.mockRejectedValue(new Error('connection lost'));

      await expect(
        controller.uploadCertificate(buildFile(), body, userA),
      ).rejects.toThrow(InternalServerErrorException);

      expect(certificateService.saveCertificateFile).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('responde éxito aunque falle la copia en disco: la BD ya lo tiene', async () => {
      db.queryOne.mockResolvedValueOnce({ certificado_nombre: null });
      certificateService.saveCertificateFile.mockImplementation(() => {
        throw new Error('EROFS: read-only file system');
      });

      const res = await controller.uploadCertificate(buildFile(), body, userA);

      expect(res.success).toBe(true);
      expect(res.data.emisorBinding.ruc).toBe(RUC);
    });

    it('borra el archivo anterior del emisor solo si nadie más lo usa', async () => {
      db.queryOne
        .mockResolvedValueOnce({ certificado_nombre: 'firma.p12' }) // nombre anterior
        .mockResolvedValueOnce(null); // ya ningún emisor lo referencia

      await controller.uploadCertificate(buildFile(), body, userA);

      expect(certificateService.deleteCertificate).toHaveBeenCalledWith(
        'firma.p12',
      );
    });

    it('conserva el archivo anterior si otro emisor todavía lo usa', async () => {
      db.queryOne
        .mockResolvedValueOnce({ certificado_nombre: 'firma.p12' })
        .mockResolvedValueOnce({ id: 'emisor-b' });

      await controller.uploadCertificate(buildFile(), body, userA);

      expect(certificateService.deleteCertificate).not.toHaveBeenCalled();
    });
  });

  describe('GET list-certs', () => {
    const files = [
      { name: `${RUC}.p12`, size: 1, createdAt: new Date(), modifiedAt: new Date() },
      { name: 'otro.p12', size: 1, createdAt: new Date(), modifiedAt: new Date() },
    ];

    it('un usuario normal solo ve los certificados de su tenant', async () => {
      certificateService.listAllCertificates.mockReturnValue(files);
      db.queryAll.mockResolvedValue([
        {
          certificado_nombre: `${RUC}.p12`,
          ruc: RUC,
          razon_social: 'NEGOCIO A',
          certificado_valido_hasta: null,
          certificado_sujeto: null,
        },
      ]);

      const res = await controller.listCertificates(userA);

      const [sql, params] = db.queryAll.mock.calls[0];
      expect(sql).toContain('tenant_id = $2');
      expect(params[1]).toBe(TENANT_A);
      expect(res.data.total).toBe(1);
      expect(res.data.certificates.map((c: any) => c.name)).toEqual([
        `${RUC}.p12`,
      ]);
    });

    it('un usuario sin tenant no ve ningún certificado', async () => {
      certificateService.listAllCertificates.mockReturnValue(files);

      const res = await controller.listCertificates({
        ...userA,
        tenantId: null,
      });

      expect(db.queryAll).not.toHaveBeenCalled();
      expect(res.data.total).toBe(0);
    });

    it('SUPERADMIN ve todos, sin filtro de tenant', async () => {
      certificateService.listAllCertificates.mockReturnValue(files);

      const res = await controller.listCertificates(superadmin);

      expect(db.queryAll.mock.calls[0][0]).not.toContain('tenant_id');
      expect(res.data.total).toBe(2);
    });
  });

  describe('cert-info y validate-cert', () => {
    it('cert-info responde 404 si el certificado es de otro tenant', async () => {
      db.queryOne.mockResolvedValue(null);

      await expect(
        controller.getCertificateInfo('otro.p12', userA),
      ).rejects.toThrow(NotFoundException);

      expect(db.queryOne.mock.calls[0][1]).toEqual(['otro.p12', TENANT_A]);
      expect(certificateService.getCertificateInfo).not.toHaveBeenCalled();
    });

    it('validate-cert responde 404 si el certificado es de otro tenant', async () => {
      db.queryOne.mockResolvedValue(null);

      await expect(
        controller.validateCertificate('otro.p12', { password: 'x' }, userA),
      ).rejects.toThrow(NotFoundException);

      expect(
        certificateService.validateCertificateExpiry,
      ).not.toHaveBeenCalled();
    });

    it('cert-info funciona para el dueño del certificado', async () => {
      db.queryOne.mockResolvedValue({ id: 'emisor-a' });

      const res = await controller.getCertificateInfo(`${RUC}.p12`, userA);

      expect(res.success).toBe(true);
    });

    it('rechaza nombres con ruta', async () => {
      await expect(
        controller.getCertificateInfo('../../etc/x.p12', superadmin),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('DELETE delete-cert', () => {
    it('solo limpia los emisores del tenant que lo pide', async () => {
      db.queryOne
        .mockResolvedValueOnce({ id: 'emisor-a' }) // acceso
        .mockResolvedValueOnce({ id: 'emisor-b' }); // otro tenant aún lo usa
      db.query.mockResolvedValue({ rows: [{ id: 'emisor-a', ruc: RUC }] });

      const res = await controller.deleteCertificate('firma.p12', userA);

      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('tenant_id = $2');
      expect(params).toEqual(['firma.p12', TENANT_A]);
      expect(res.data.emisoresActualizados).toBe(1);
      // El archivo lo sigue usando el emisor de otro tenant
      expect(certificateService.deleteCertificate).not.toHaveBeenCalled();
      expect(xmlSignerService.clearEmisorCache).toHaveBeenCalledWith(RUC);
    });

    it('responde 404 si el certificado es de otro tenant', async () => {
      db.queryOne.mockResolvedValue(null);

      await expect(
        controller.deleteCertificate('otro.p12', {
          ...userA,
          tenantId: TENANT_B,
        }),
      ).rejects.toThrow(NotFoundException);

      expect(db.query).not.toHaveBeenCalled();
    });
  });
});
