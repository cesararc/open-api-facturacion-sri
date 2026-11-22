import { FacturaService } from './factura.service';
import { CreateFacturaDto } from '../dto';
import { TipoIdentificacion, FormaPago } from '../constants';

/**
 * Idempotencia de emitirFactura por referenciaExterna.
 * Lo que está en juego: que una misma venta nunca termine con dos facturas
 * autorizadas, y que una factura pendiente no se abandone.
 */
describe('FacturaService — idempotencia por referenciaExterna', () => {
  const CLAVE_NUEVA = '0702202601092438363100120010010000000171245294019';
  const CLAVE_PREVIA = '0602202601092438363100120010010000000161245294013';
  const REF = 'venta-abc-123';

  let service: FacturaService;
  let claveAccesoService: any;
  let xmlBuilderService: any;
  let xmlSignerService: any;
  let sriSoapClient: any;
  let repository: any;
  let xmlStorage: any;
  let base: any;
  let eventEmitter: any;

  const emisor = {
    id: 'emisor-1',
    ruc: '0924383631001',
    certificado_nombre: '0924383631001.p12',
    certificado_password_encrypted: 'v2:x',
  };

  const autorizadoSri = {
    success: true,
    claveAcceso: CLAVE_NUEVA,
    estado: 'AUTORIZADO',
    fechaAutorizacion: '2026-02-07T10:00:00-05:00',
    numeroAutorizacion: CLAVE_NUEVA,
    xmlAutorizado: '<autorizado/>',
    mensajes: [],
  };

  function dto(extra: Partial<CreateFacturaDto> = {}): CreateFacturaDto {
    return {
      ambiente: '2',
      fechaEmision: '07/02/2026',
      referenciaExterna: REF,
      emisor: {
        ruc: emisor.ruc,
        razonSocial: 'Negocio Test',
        dirMatriz: 'Quito',
        establecimiento: '001',
        puntoEmision: '001',
        obligadoContabilidad: 'NO',
      },
      comprador: {
        tipoIdentificacion: TipoIdentificacion.CONSUMIDOR_FINAL,
        identificacion: '9999999999999',
        razonSocial: 'CONSUMIDOR FINAL',
      },
      detalles: [
        {
          codigoPrincipal: 'PROD001',
          descripcion: 'Producto',
          cantidad: 1,
          precioUnitario: 10,
          descuento: 0,
          impuestos: [
            {
              codigo: '2',
              codigoPorcentaje: '4',
              tarifa: 15,
              baseImponible: 10,
              valor: 1.5,
            },
          ],
        },
      ],
      pagos: [
        {
          formaPago: FormaPago.SIN_UTILIZACION_SISTEMA_FINANCIERO,
          total: 11.5,
        },
      ],
      ...extra,
    } as any as CreateFacturaDto;
  }

  function comprobantePrevio(estado: string, extra: Record<string, any> = {}) {
    return {
      id: 'comp-previo',
      emisor_id: emisor.id,
      punto_emision_id: 'pe-1',
      tipo_comprobante: '01',
      ambiente: '2',
      tipo_emision: '1',
      secuencial: '000000016',
      clave_acceso: CLAVE_PREVIA,
      fecha_emision: '2026-02-06',
      estado,
      id_referencia_externa: REF,
      ...extra,
    };
  }

  /** Respuesta de consulta de autorización del SRI */
  function consultaSri(estado?: string, extra: Record<string, any> = {}) {
    return {
      claveAccesoConsultada: CLAVE_PREVIA,
      numeroComprobantes: estado ? '1' : '0',
      autorizaciones: estado
        ? { autorizacion: [{ estado, ambiente: 'PRODUCCION', ...extra }] }
        : undefined,
    };
  }

  beforeEach(() => {
    claveAccesoService = { generate: jest.fn().mockReturnValue(CLAVE_NUEVA) };
    xmlBuilderService = { buildFactura: jest.fn().mockReturnValue('<f/>') };
    xmlSignerService = {
      signXmlForEmisor: jest.fn().mockResolvedValue('<f firmado/>'),
    };
    sriSoapClient = {
      enviarYAutorizar: jest.fn().mockResolvedValue(autorizadoSri),
      autorizarComprobante: jest.fn(),
    };
    repository = {
      findEmisorByRuc: jest.fn().mockResolvedValue(emisor),
      findPuntoEmision: jest.fn().mockResolvedValue({
        punto_emision_id: 'pe-1',
        establecimiento_id: 'est-1',
      }),
      findComprobantesByReferenciaExterna: jest.fn().mockResolvedValue([]),
      executeInTransaction: jest.fn((cb: any) => cb({})),
      getNextSecuencial: jest.fn().mockResolvedValue('000000017'),
      createComprobante: jest.fn().mockResolvedValue({ id: 'comp-nuevo' }),
      createDetalles: jest.fn().mockResolvedValue([{ id: 'det-1' }]),
      createImpuestos: jest.fn().mockResolvedValue([]),
      createTotales: jest.fn().mockResolvedValue([]),
      createPagos: jest.fn().mockResolvedValue([]),
      createInfoAdicional: jest.fn().mockResolvedValue([]),
      createDetallesAdicionales: jest.fn().mockResolvedValue([]),
      saveXml: jest.fn().mockResolvedValue(undefined),
      updateComprobante: jest.fn().mockResolvedValue(undefined),
      findXmlByComprobanteId: jest.fn().mockResolvedValue({
        xml_firmado_path: 'ruc/2026/02/firmados/previo.xml',
        xml_autorizado_path: 'ruc/2026/02/autorizados/previo.xml',
      }),
    };
    xmlStorage = {
      saveAllXmls: jest.fn().mockReturnValue({ firmadoPath: 'f.xml' }),
      saveXml: jest.fn().mockReturnValue('autorizado.xml'),
      readXml: jest.fn().mockReturnValue('<xml guardado/>'),
    };
    base = {
      validarIdentificacion: jest.fn(),
      validarTipoIdentificacionCatalogo: jest.fn().mockResolvedValue(undefined),
      validarImpuestosDetalles: jest.fn().mockResolvedValue(undefined),
      validarFormasPagoCatalogo: jest.fn().mockResolvedValue(undefined),
      getDefaultAmbiente: jest.fn().mockReturnValue('1'),
      injectProveedorRucInfoAdicional: jest.fn(async (info: any[]) => info),
    };
    eventEmitter = { emit: jest.fn() };

    service = new FacturaService(
      claveAccesoService,
      xmlBuilderService,
      xmlSignerService,
      sriSoapClient,
      repository,
      xmlStorage,
      base,
      eventEmitter,
    );
  });

  describe('sin comprobantes previos', () => {
    it('emite y guarda la referencia en el comprobante', async () => {
      const res = await service.emitirFactura(dto());

      expect(res.success).toBe(true);
      expect(repository.getNextSecuencial).toHaveBeenCalledTimes(1);
      expect(repository.createComprobante).toHaveBeenCalledWith(
        expect.objectContaining({ id_referencia_externa: REF }),
        expect.anything(),
      );
    });

    it('busca solo dentro del emisor, tipo factura y ambiente pedido', async () => {
      await service.emitirFactura(dto());

      expect(
        repository.findComprobantesByReferenciaExterna,
      ).toHaveBeenCalledWith(emisor.id, '01', '2', REF);
    });

    it('sin referenciaExterna no consulta nada: comportamiento de siempre', async () => {
      await service.emitirFactura(dto({ referenciaExterna: undefined }));

      expect(
        repository.findComprobantesByReferenciaExterna,
      ).not.toHaveBeenCalled();
      expect(repository.createComprobante).toHaveBeenCalledWith(
        expect.objectContaining({ id_referencia_externa: undefined }),
        expect.anything(),
      );
    });

    it('guarda la referencia también cuando el SRI no responde (queda PENDIENTE)', async () => {
      sriSoapClient.enviarYAutorizar.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(service.emitirFactura(dto())).rejects.toThrow('ETIMEDOUT');

      expect(repository.createComprobante).toHaveBeenCalledWith(
        expect.objectContaining({
          estado: 'PENDIENTE',
          id_referencia_externa: REF,
        }),
        expect.anything(),
      );
    });
  });

  describe('ya existe una factura AUTORIZADA para la referencia', () => {
    beforeEach(() => {
      repository.findComprobantesByReferenciaExterna.mockResolvedValue([
        comprobantePrevio('AUTORIZADO', {
          fecha_autorizacion: new Date('2026-02-06T15:00:00Z'),
          numero_autorizacion: CLAVE_PREVIA,
        }),
      ]);
    });

    it('devuelve esa factura', async () => {
      const res = await service.emitirFactura(dto());

      expect(res).toEqual({
        success: true,
        claveAcceso: CLAVE_PREVIA,
        estado: 'AUTORIZADO',
        fechaAutorizacion: '2026-02-06T15:00:00.000Z',
        numeroAutorizacion: CLAVE_PREVIA,
        xmlAutorizado: '<xml guardado/>',
        mensajes: [],
      });
    });

    it('no gasta secuencial, no firma y no llama al SRI', async () => {
      await service.emitirFactura(dto());

      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
      expect(xmlSignerService.signXmlForEmisor).not.toHaveBeenCalled();
      expect(sriSoapClient.enviarYAutorizar).not.toHaveBeenCalled();
      expect(sriSoapClient.autorizarComprobante).not.toHaveBeenCalled();
      expect(repository.createComprobante).not.toHaveBeenCalled();
    });

    it('la devuelve aunque haya intentos rechazados más recientes', async () => {
      repository.findComprobantesByReferenciaExterna.mockResolvedValue([
        comprobantePrevio('DEVUELTA', { id: 'comp-rechazado' }),
        comprobantePrevio('AUTORIZADO'),
      ]);

      const res = await service.emitirFactura(dto());

      expect(res.claveAcceso).toBe(CLAVE_PREVIA);
      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
    });

    it('la devuelve aunque no se pueda leer el XML autorizado', async () => {
      repository.findXmlByComprobanteId.mockRejectedValue(new Error('db'));

      const res = await service.emitirFactura(dto());

      expect(res.success).toBe(true);
      expect(res.xmlAutorizado).toBeUndefined();
    });
  });

  describe('el intento previo quedó PENDIENTE', () => {
    beforeEach(() => {
      repository.findComprobantesByReferenciaExterna.mockResolvedValue([
        comprobantePrevio('PENDIENTE'),
      ]);
    });

    it('si el SRI ya lo autorizó: lo marca AUTORIZADO y lo devuelve sin emitir otro', async () => {
      sriSoapClient.autorizarComprobante.mockResolvedValue(
        consultaSri('AUTORIZADO', {
          fechaAutorizacion: '2026-02-06T10:05:00-05:00',
          numeroAutorizacion: CLAVE_PREVIA,
          comprobante: '<autorizado previo/>',
        }),
      );

      const res = await service.emitirFactura(dto());

      expect(res.success).toBe(true);
      expect(res.claveAcceso).toBe(CLAVE_PREVIA);
      expect(repository.updateComprobante).toHaveBeenCalledWith(
        'comp-previo',
        expect.objectContaining({
          estado: 'AUTORIZADO',
          numero_autorizacion: CLAVE_PREVIA,
        }),
      );
      expect(xmlStorage.saveXml).toHaveBeenCalledWith(
        emisor.ruc,
        CLAVE_PREVIA,
        expect.any(Date),
        'autorizado',
        '<autorizado previo/>',
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'comprobante.autorizado',
        expect.objectContaining({ claveAcceso: CLAVE_PREVIA }),
      );
      expect(sriSoapClient.enviarYAutorizar).not.toHaveBeenCalled();
      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
    });

    it('si el SRI no lo tiene: reenvía el mismo XML firmado con la misma clave', async () => {
      sriSoapClient.autorizarComprobante.mockResolvedValue(consultaSri());
      sriSoapClient.enviarYAutorizar.mockResolvedValue({
        ...autorizadoSri,
        claveAcceso: CLAVE_PREVIA,
        numeroAutorizacion: CLAVE_PREVIA,
      });

      const res = await service.emitirFactura(dto());

      expect(sriSoapClient.enviarYAutorizar).toHaveBeenCalledTimes(1);
      expect(sriSoapClient.enviarYAutorizar).toHaveBeenCalledWith(
        '<xml guardado/>',
        CLAVE_PREVIA,
      );
      expect(res.claveAcceso).toBe(CLAVE_PREVIA);
      // No se generó una factura nueva
      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
      expect(xmlSignerService.signXmlForEmisor).not.toHaveBeenCalled();
      expect(repository.createComprobante).not.toHaveBeenCalled();
    });

    it('si el SRI sigue procesándolo: responde EN PROCESO y no emite otro', async () => {
      sriSoapClient.autorizarComprobante.mockResolvedValue(
        consultaSri('EN PROCESO'),
      );

      const res = await service.emitirFactura(dto());

      expect(res.success).toBe(false);
      expect(res.estado).toBe('EN PROCESO');
      expect(res.claveAcceso).toBe(CLAVE_PREVIA);
      expect(sriSoapClient.enviarYAutorizar).not.toHaveBeenCalled();
      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
    });

    it.each(['43', '70'])(
      'si al reenviar el SRI responde que ya tiene la clave (%s): EN PROCESO, no emite otro',
      async (identificador) => {
        sriSoapClient.autorizarComprobante.mockResolvedValue(consultaSri());
        sriSoapClient.enviarYAutorizar.mockResolvedValue({
          success: false,
          claveAcceso: CLAVE_PREVIA,
          estado: 'DEVUELTA',
          mensajes: [
            { identificador, mensaje: 'CLAVE ACCESO REGISTRADA', tipo: 'ERROR' },
          ],
        });

        const res = await service.emitirFactura(dto());

        expect(res.estado).toBe('EN PROCESO');
        expect(repository.getNextSecuencial).not.toHaveBeenCalled();
        expect(repository.updateComprobante).toHaveBeenCalledWith(
          'comp-previo',
          expect.objectContaining({ estado: 'EN PROCESO' }),
        );
      },
    );

    it('si el SRI lo rechazó (NO AUTORIZADO): lo marca y emite una factura nueva', async () => {
      sriSoapClient.autorizarComprobante.mockResolvedValue(
        consultaSri('NO AUTORIZADO'),
      );

      const res = await service.emitirFactura(dto());

      expect(repository.updateComprobante).toHaveBeenCalledWith(
        'comp-previo',
        expect.objectContaining({ estado: 'NO AUTORIZADO' }),
      );
      expect(repository.getNextSecuencial).toHaveBeenCalledTimes(1);
      expect(res.claveAcceso).toBe(CLAVE_NUEVA);
      expect(res.success).toBe(true);
    });

    it('si al reenviar el SRI lo devuelve por otro motivo: emite una factura nueva', async () => {
      sriSoapClient.autorizarComprobante.mockResolvedValue(consultaSri());
      sriSoapClient.enviarYAutorizar
        .mockResolvedValueOnce({
          success: false,
          claveAcceso: CLAVE_PREVIA,
          estado: 'DEVUELTA',
          mensajes: [
            { identificador: '35', mensaje: 'ARCHIVO NO CUMPLE', tipo: 'ERROR' },
          ],
        })
        .mockResolvedValueOnce(autorizadoSri);

      const res = await service.emitirFactura(dto());

      expect(repository.updateComprobante).toHaveBeenCalledWith(
        'comp-previo',
        expect.objectContaining({ estado: 'DEVUELTA' }),
      );
      expect(res.claveAcceso).toBe(CLAVE_NUEVA);
      expect(repository.getNextSecuencial).toHaveBeenCalledTimes(1);
    });

    it('si no se puede consultar al SRI: falla y NO emite otra factura', async () => {
      sriSoapClient.autorizarComprobante.mockRejectedValue(
        new Error('SRI no disponible'),
      );

      await expect(service.emitirFactura(dto())).rejects.toThrow(
        'SRI no disponible',
      );

      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
      expect(sriSoapClient.enviarYAutorizar).not.toHaveBeenCalled();
    });

    it('si falta el XML firmado: EN PROCESO con aviso, no emite otra', async () => {
      sriSoapClient.autorizarComprobante.mockResolvedValue(consultaSri());
      repository.findXmlByComprobanteId.mockResolvedValue(null);

      const res = await service.emitirFactura(dto());

      expect(res.estado).toBe('EN PROCESO');
      expect(res.mensajes?.[0].mensaje).toContain('revisión manual');
      expect(sriSoapClient.enviarYAutorizar).not.toHaveBeenCalled();
      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
    });
  });

  describe('los intentos previos fueron rechazados', () => {
    it.each(['DEVUELTA', 'NO AUTORIZADO', 'RECHAZADO', 'ANULADO'])(
      'con un previo %s emite una factura nueva sin consultar al SRI',
      async (estado) => {
        repository.findComprobantesByReferenciaExterna.mockResolvedValue([
          comprobantePrevio(estado),
        ]);

        const res = await service.emitirFactura(dto());

        expect(sriSoapClient.autorizarComprobante).not.toHaveBeenCalled();
        expect(repository.getNextSecuencial).toHaveBeenCalledTimes(1);
        expect(res.claveAcceso).toBe(CLAVE_NUEVA);
      },
    );
  });

  describe('solicitudes simultáneas de la misma venta', () => {
    it('la segunda espera a la primera: una sola factura', async () => {
      let liberar!: (v: any) => void;
      sriSoapClient.enviarYAutorizar.mockReturnValue(
        new Promise((resolve) => {
          liberar = resolve;
        }),
      );

      const primera = service.emitirFactura(dto());
      const segunda = service.emitirFactura(dto());
      await new Promise((r) => setImmediate(r));
      liberar(autorizadoSri);

      const [r1, r2] = await Promise.all([primera, segunda]);

      expect(r1).toEqual(r2);
      expect(repository.getNextSecuencial).toHaveBeenCalledTimes(1);
      expect(sriSoapClient.enviarYAutorizar).toHaveBeenCalledTimes(1);
    });

    it('referencias distintas no se bloquean entre sí', async () => {
      await Promise.all([
        service.emitirFactura(dto({ referenciaExterna: 'venta-1' })),
        service.emitirFactura(dto({ referenciaExterna: 'venta-2' })),
      ]);

      expect(repository.getNextSecuencial).toHaveBeenCalledTimes(2);
    });

    it('al terminar libera la referencia, también si falló', async () => {
      sriSoapClient.enviarYAutorizar.mockRejectedValueOnce(new Error('caído'));
      await expect(service.emitirFactura(dto())).rejects.toThrow('caído');

      sriSoapClient.enviarYAutorizar.mockResolvedValue(autorizadoSri);
      const res = await service.emitirFactura(dto());

      expect(res.success).toBe(true);
      expect((service as any).emisionesEnCurso.size).toBe(0);
    });
  });
});
