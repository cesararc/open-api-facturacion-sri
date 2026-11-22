import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PoolClient } from 'pg';
import { Decimal } from 'decimal.js';
import { ClaveAccesoService } from './clave-acceso.service';
import { XmlBuilderService } from './xml-builder.service';
import { XmlSignerService } from './xml-signer.service';
import { SriSoapClient } from './sri-soap.client';
import { SriRepositoryService } from './sri-repository.service';
import { XmlStorageService } from './xml-storage.service';
import { SriBaseService } from './sri-base.service';
import { CreateFacturaDto, FacturaResponseDto } from '../dto';
import {
  Factura,
  InfoTributaria,
  InfoFactura,
  DetalleFactura,
  TotalImpuesto,
  SriOperationResult,
} from '../interfaces';
import { ComprobanteRecord } from '../interfaces/repository.interface';
import { TipoComprobante, Ambiente, TipoEmision } from '../constants';
import { extractRucFromClaveAcceso } from '../utils/clave-acceso.utils';

@Injectable()
export class FacturaService {
  private readonly logger = new Logger(FacturaService.name);

  constructor(
    private readonly claveAccesoService: ClaveAccesoService,
    private readonly xmlBuilderService: XmlBuilderService,
    private readonly xmlSignerService: XmlSignerService,
    private readonly sriSoapClient: SriSoapClient,
    private readonly repository: SriRepositoryService,
    private readonly xmlStorage: XmlStorageService,
    private readonly base: SriBaseService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Emisiones con referenciaExterna que esta instancia está procesando ahora.
   * Si llega la misma venta dos veces a la vez (reintento del cliente mientras
   * el SRI aún responde), la segunda espera el resultado de la primera en vez
   * de emitir otra factura. Cubre una sola instancia: entre instancias, quien
   * llama debe serializar por venta (el MCP lo hace con su candado en Firestore).
   */
  private readonly emisionesEnCurso = new Map<
    string,
    Promise<FacturaResponseDto>
  >();

  /**
   * Emite una factura electrónica. Con `referenciaExterna` la operación es
   * idempotente: ver resolverEmisionPrevia().
   */
  async emitirFactura(dto: CreateFacturaDto): Promise<FacturaResponseDto> {
    if (!dto.referenciaExterna) {
      return this.ejecutarEmision(dto);
    }

    const key = `${dto.emisor.ruc}:${dto.referenciaExterna}`;
    const enCurso = this.emisionesEnCurso.get(key);
    if (enCurso) {
      this.logger.warn(
        `Emisión simultánea para la referencia ${dto.referenciaExterna}: se espera la que ya está en curso`,
      );
      return enCurso;
    }

    const emision = this.ejecutarEmision(dto).finally(() => {
      this.emisionesEnCurso.delete(key);
    });
    this.emisionesEnCurso.set(key, emision);
    return emision;
  }

  /**
   * Emite una factura electrónica completa: valida, genera XML, firma, envía al SRI y persiste
   * Patrón de 3 fases — nunca bloquea el pool de DB durante la llamada SOAP al SRI
   */
  private async ejecutarEmision(
    dto: CreateFacturaDto,
  ): Promise<FacturaResponseDto> {
    this.logger.log('Iniciando emisión de factura electrónica');

    try {
      // ========== PARALLEL BLOCK: Validaciones + Búsqueda Emisor ==========
      // Validación síncrona (no bloquea)
      this.base.validarIdentificacion(
        dto.comprador.tipoIdentificacion,
        dto.comprador.identificacion,
        'comprador',
      );

      // Ejecutar validaciones de catálogo Y búsqueda de emisor en paralelo
      const [, , , emisor] = await Promise.all([
        this.base.validarTipoIdentificacionCatalogo(
          dto.comprador.tipoIdentificacion,
        ),
        this.base.validarImpuestosDetalles(dto.detalles),
        dto.pagos && dto.pagos.length > 0
          ? this.base.validarFormasPagoCatalogo(dto.pagos)
          : Promise.resolve(),
        this.repository.findEmisorByRuc(dto.emisor.ruc),
      ]);

      // Variables de configuración
      const ambiente = dto.ambiente || this.base.getDefaultAmbiente();
      const tipoEmision = dto.tipoEmision || TipoEmision.NORMAL;
      const [day, month, year] = dto.fechaEmision.split('/');
      const fechaEmision = new Date(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
      );

      // Buscar punto de emisión
      const puntoEmisionInfo = emisor
        ? await this.repository.findPuntoEmision(
            emisor.id,
            dto.emisor.establecimiento,
            dto.emisor.puntoEmision,
          )
        : null;

      // ─── IDEMPOTENCIA: antes de gastar un secuencial ───
      if (dto.referenciaExterna && emisor) {
        const previa = await this.resolverEmisionPrevia(
          emisor.id,
          ambiente,
          dto.referenciaExterna,
        );
        if (previa) {
          return previa;
        }
      }

      // ─── FASE 1: Transacción corta (~5ms) — Solo reservar secuencial ───
      let secuencial: string;
      if (dto.secuencial) {
        secuencial = dto.secuencial.padStart(9, '0');
      } else {
        if (!puntoEmisionInfo) {
          throw new BadRequestException(
            `No se puede generar secuencial automático: punto de emisión ${dto.emisor.establecimiento}-${dto.emisor.puntoEmision} no encontrado para emisor ${dto.emisor.ruc}`,
          );
        }
        secuencial = await this.repository.executeInTransaction(
          async (client) => {
            return this.repository.getNextSecuencial(
              puntoEmisionInfo.punto_emision_id,
              TipoComprobante.FACTURA,
              client,
            );
          },
        );
      }

      // ─── FASE 2: Fuera de transacción — Firma + Envío al SRI ───
      // Sin conexión de DB abierta. El pool queda libre para otros usuarios.
      const claveAcceso = this.claveAccesoService.generate({
        fechaEmision,
        tipoComprobante: TipoComprobante.FACTURA,
        ruc: dto.emisor.ruc,
        ambiente,
        establecimiento: dto.emisor.establecimiento,
        puntoEmision: dto.emisor.puntoEmision,
        secuencial,
        tipoEmision,
      });

      const factura = await this.buildFacturaFromDto(
        dto,
        claveAcceso,
        secuencial,
        ambiente,
        tipoEmision,
      );
      const xml = this.xmlBuilderService.buildFactura(factura);

      // Verificar certificado
      if (
        !emisor ||
        (!emisor.certificado_p12 && !emisor.certificado_nombre) ||
        !emisor.certificado_password_encrypted
      ) {
        throw new BadRequestException(
          `El emisor con RUC ${dto.emisor.ruc} no tiene certificado digital configurado. ` +
            'Use el endpoint POST /certificates/upload-cert con el RUC para vincular un certificado P12.',
        );
      }

      // Firmar XML
      const xmlFirmado = await this.xmlSignerService.signXmlForEmisor(
        xml,
        dto.emisor.ruc,
      );

      // Enviar y autorizar en SRI (puede tardar 2-10 segundos — sin bloquear DB)
      let resultado: SriOperationResult;
      try {
        resultado = await this.sriSoapClient.enviarYAutorizar(
          xmlFirmado,
          claveAcceso,
        );
      } catch (error) {
        // El SRI no respondió — guardar como PENDIENTE para reintento posterior
        if (emisor && puntoEmisionInfo) {
          await this.repository.executeInTransaction(async (client) => {
            await this.persistirFactura(
              dto,
              factura,
              emisor.id,
              puntoEmisionInfo.punto_emision_id,
              claveAcceso,
              secuencial,
              ambiente,
              tipoEmision,
              xml,
              xmlFirmado,
              {
                success: false,
                claveAcceso,
                estado: 'PENDIENTE',
                mensajes: [
                  {
                    identificador: 'SRI_TIMEOUT',
                    mensaje: (error as Error).message,
                    tipo: 'ERROR',
                  },
                ],
              },
              client,
            );
          });
        }
        throw error;
      }

      // ─── FASE 3: Transacción corta (~5ms) — Solo persistir resultado ───
      if (emisor && puntoEmisionInfo) {
        await this.repository.executeInTransaction(async (client) => {
          await this.persistirFactura(
            dto,
            factura,
            emisor.id,
            puntoEmisionInfo.punto_emision_id,
            claveAcceso,
            secuencial,
            ambiente,
            tipoEmision,
            xml,
            xmlFirmado,
            resultado,
            client,
          );
        });
      }

      // 4. Emitir eventos para Webhooks
      if (resultado.success || resultado.estado === 'AUTORIZADO') {
        this.eventEmitter.emit('comprobante.autorizado', {
          emisorId: emisor?.id,
          claveAcceso,
          tipoComprobante: TipoComprobante.FACTURA,
          secuencial,
          fechaAutorizacion: resultado.fechaAutorizacion,
          numeroAutorizacion: resultado.numeroAutorizacion,
        });
      } else if (
        resultado.estado === 'RECHAZADO' ||
        resultado.estado === 'DEVUELTA'
      ) {
        this.eventEmitter.emit('comprobante.rechazado', {
          emisorId: emisor?.id,
          claveAcceso,
          tipoComprobante: TipoComprobante.FACTURA,
          estado: resultado.estado,
          mensajes: resultado.mensajes,
        });
      }

      return this.mapResultToResponse(resultado);
    } catch (error) {
      this.logger.error(`Error al emitir factura: ${(error as Error).message}`);
      throw error;
    }
  }

  // ==========================================
  // IDEMPOTENCIA POR REFERENCIA EXTERNA
  // ==========================================

  /**
   * Decide qué hacer cuando el emisor ya tiene comprobantes con esta referencia:
   *
   * - Uno AUTORIZADO      → se devuelve ese. No se emite nada.
   * - Uno sin resolver    → se resuelve contra el SRI con su misma clave de
   *                         acceso (consulta y, si el SRI no lo tiene, reenvío
   *                         del mismo XML firmado). Nunca se emite otro mientras
   *                         no se sepa qué pasó con este.
   * - Solo rechazados     → null: el llamador emite una factura nueva.
   *
   * Retorna la respuesta a devolver, o null si corresponde emitir.
   */
  private async resolverEmisionPrevia(
    emisorId: string,
    ambiente: string,
    referenciaExterna: string,
  ): Promise<FacturaResponseDto | null> {
    const previos = await this.repository.findComprobantesByReferenciaExterna(
      emisorId,
      TipoComprobante.FACTURA,
      ambiente,
      referenciaExterna,
    );
    if (previos.length === 0) {
      return null;
    }

    const autorizado = previos.find((c) => c.estado === 'AUTORIZADO');
    if (autorizado) {
      this.logger.log(
        `Referencia ${referenciaExterna} ya tiene factura autorizada ...${autorizado.clave_acceso.slice(-8)}: se devuelve sin emitir otra`,
      );
      return this.comprobanteAutorizadoToResponse(autorizado);
    }

    for (const comprobante of previos) {
      if (!FacturaService.ESTADOS_SIN_RESOLVER.includes(comprobante.estado)) {
        continue;
      }
      const respuesta = await this.resolverComprobantePendiente(comprobante);
      if (respuesta) {
        return respuesta;
      }
      // El SRI lo rechazó: seguir revisando y, si no queda ninguno, emitir uno nuevo
    }

    return null;
  }

  /** Estados en los que todavía no se sabe si el SRI autorizó el comprobante */
  private static readonly ESTADOS_SIN_RESOLVER = [
    'PENDIENTE',
    'EN PROCESO',
    'EN_PROCESO',
    'RECIBIDA',
  ];

  /**
   * Identificadores con los que el SRI devuelve un comprobante que en realidad
   * ya tiene: 43 = clave de acceso registrada, 70 = clave en procesamiento.
   */
  private static readonly SRI_CLAVE_YA_RECIBIDA = ['43', '70'];

  /**
   * Resuelve un comprobante que quedó sin respuesta definitiva del SRI.
   * Retorna la respuesta a devolver (autorizado o todavía en proceso), o null
   * si el SRI lo rechazó y por lo tanto se puede emitir uno nuevo.
   */
  private async resolverComprobantePendiente(
    comprobante: ComprobanteRecord,
  ): Promise<FacturaResponseDto | null> {
    const claveAcceso = comprobante.clave_acceso;
    this.logger.log(
      `Resolviendo comprobante pendiente ...${claveAcceso.slice(-8)} contra el SRI`,
    );

    // 1. ¿El SRI ya lo conoce? Si la consulta falla, el error sube: sin saber
    //    qué pasó con este comprobante no se emite otro.
    let resultado = await this.consultarEstadoEnSri(claveAcceso);

    // 2. El SRI no lo tiene: reenviar el mismo XML firmado. Misma clave de
    //    acceso, así que no puede generar una segunda factura.
    if (!resultado) {
      const xmlFirmado = await this.leerXmlFirmado(comprobante.id!);
      if (!xmlFirmado) {
        this.logger.error(
          `Comprobante pendiente ...${claveAcceso.slice(-8)} sin XML firmado: no se puede reenviar. Requiere revisión manual.`,
        );
        return this.respuestaEnProceso(
          claveAcceso,
          'El comprobante quedó pendiente y no se encontró su XML firmado para reenviarlo. Requiere revisión manual.',
        );
      }
      resultado = await this.sriSoapClient.enviarYAutorizar(
        xmlFirmado,
        claveAcceso,
      );
    }

    if (resultado.success && resultado.estado === 'AUTORIZADO') {
      await this.marcarComprobanteAutorizado(comprobante, resultado);
      return this.mapResultToResponse(resultado);
    }

    const sriYaLoTiene =
      resultado.estado === 'DEVUELTA' &&
      resultado.mensajes.some((m) =>
        FacturaService.SRI_CLAVE_YA_RECIBIDA.includes(String(m.identificador)),
      );

    if (resultado.estado === 'EN PROCESO' || sriYaLoTiene) {
      await this.repository.updateComprobante(comprobante.id!, {
        estado: 'EN PROCESO',
        estado_sri: 'EN PROCESO',
      });
      return this.respuestaEnProceso(
        claveAcceso,
        'El SRI todavía está procesando el comprobante. Vuelva a intentar en unos minutos.',
      );
    }

    // Rechazo definitivo (DEVUELTA / NO AUTORIZADO)
    await this.repository.updateComprobante(comprobante.id!, {
      estado: resultado.estado,
      estado_sri: resultado.estado,
    });
    this.eventEmitter.emit('comprobante.rechazado', {
      emisorId: comprobante.emisor_id,
      claveAcceso,
      tipoComprobante: TipoComprobante.FACTURA,
      estado: resultado.estado,
      mensajes: resultado.mensajes,
    });
    this.logger.warn(
      `Comprobante pendiente ...${claveAcceso.slice(-8)} rechazado por el SRI (${resultado.estado}): se emitirá uno nuevo`,
    );
    return null;
  }

  /**
   * Consulta la autorización en el SRI. Retorna null si el SRI no tiene
   * registro de la clave (nunca la recibió).
   */
  private async consultarEstadoEnSri(
    claveAcceso: string,
  ): Promise<SriOperationResult | null> {
    const respuesta = await this.sriSoapClient.autorizarComprobante(claveAcceso);
    const autorizaciones = respuesta.autorizaciones?.autorizacion;
    const auth = Array.isArray(autorizaciones)
      ? autorizaciones[0]
      : autorizaciones;

    if (!auth) {
      return null;
    }

    const mensajes = auth.mensajes?.mensaje
      ? Array.isArray(auth.mensajes.mensaje)
        ? auth.mensajes.mensaje
        : [auth.mensajes.mensaje]
      : [];

    if (auth.estado === 'AUTORIZADO') {
      return {
        success: true,
        claveAcceso,
        estado: 'AUTORIZADO',
        fechaAutorizacion: auth.fechaAutorizacion,
        numeroAutorizacion: auth.numeroAutorizacion,
        xmlAutorizado: auth.comprobante,
        mensajes,
      };
    }

    return {
      success: false,
      claveAcceso,
      estado: auth.estado === 'NO AUTORIZADO' ? 'NO AUTORIZADO' : 'EN PROCESO',
      mensajes,
    };
  }

  private async leerXmlFirmado(comprobanteId: string): Promise<string | null> {
    const xmlRecord =
      await this.repository.findXmlByComprobanteId(comprobanteId);
    if (!xmlRecord?.xml_firmado_path) {
      return null;
    }
    return this.xmlStorage.readXml(
      xmlRecord.xml_firmado_path.replace(/\\/g, '/'),
    );
  }

  private async marcarComprobanteAutorizado(
    comprobante: ComprobanteRecord,
    resultado: SriOperationResult,
  ): Promise<void> {
    const claveAcceso = comprobante.clave_acceso;

    await this.repository.updateComprobante(comprobante.id!, {
      estado: 'AUTORIZADO',
      estado_sri: resultado.estado,
      fecha_autorizacion: resultado.fechaAutorizacion,
      numero_autorizacion: resultado.numeroAutorizacion || claveAcceso,
    });

    if (resultado.xmlAutorizado) {
      const autorizadoPath = this.xmlStorage.saveXml(
        extractRucFromClaveAcceso(claveAcceso),
        claveAcceso,
        new Date(comprobante.fecha_emision),
        'autorizado',
        resultado.xmlAutorizado,
      );
      await this.repository.saveXml({
        comprobante_id: comprobante.id!,
        xml_autorizado_path: autorizadoPath,
      });
    }

    this.eventEmitter.emit('comprobante.autorizado', {
      emisorId: comprobante.emisor_id,
      claveAcceso,
      tipoComprobante: TipoComprobante.FACTURA,
      secuencial: comprobante.secuencial,
      fechaAutorizacion: resultado.fechaAutorizacion,
      numeroAutorizacion: resultado.numeroAutorizacion,
    });
    this.logger.log(
      `Comprobante pendiente ...${claveAcceso.slice(-8)} quedó AUTORIZADO`,
    );
  }

  private async comprobanteAutorizadoToResponse(
    comprobante: ComprobanteRecord,
  ): Promise<FacturaResponseDto> {
    let xmlAutorizado: string | undefined;
    try {
      const xmlRecord = await this.repository.findXmlByComprobanteId(
        comprobante.id!,
      );
      if (xmlRecord?.xml_autorizado_path) {
        xmlAutorizado =
          this.xmlStorage.readXml(
            xmlRecord.xml_autorizado_path.replace(/\\/g, '/'),
          ) ?? undefined;
      }
    } catch (error) {
      // El XML es un adjunto: su ausencia no cambia que la factura ya existe
      this.logger.warn(
        `No se pudo leer el XML autorizado de ...${comprobante.clave_acceso.slice(-8)}: ${(error as Error).message}`,
      );
    }

    // pg entrega timestamptz como Date aunque el tipo del registro diga string
    const fecha = comprobante.fecha_autorizacion as string | Date | undefined;

    return {
      success: true,
      claveAcceso: comprobante.clave_acceso,
      estado: 'AUTORIZADO',
      fechaAutorizacion: fecha instanceof Date ? fecha.toISOString() : fecha,
      numeroAutorizacion:
        comprobante.numero_autorizacion || comprobante.clave_acceso,
      xmlAutorizado,
      mensajes: [],
    };
  }

  private respuestaEnProceso(
    claveAcceso: string,
    mensaje: string,
  ): FacturaResponseDto {
    return {
      success: false,
      claveAcceso,
      estado: 'EN PROCESO',
      mensajes: [
        {
          identificador: 'EN_PROCESO',
          mensaje,
          tipo: 'ADVERTENCIA',
        },
      ],
    };
  }

  /**
   * Genera XML preview de factura sin firmar ni enviar
   */
  async generarXmlPreview(dto: CreateFacturaDto): Promise<string> {
    if (!dto.secuencial) {
      throw new BadRequestException(
        'Para preview, el secuencial es obligatorio',
      );
    }
    const secuencial = dto.secuencial.padStart(9, '0');

    const ambiente = dto.ambiente || this.base.getDefaultAmbiente();
    const tipoEmision = dto.tipoEmision || TipoEmision.NORMAL;

    const [day, month, year] = dto.fechaEmision.split('/');
    const fechaEmision = new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
    );

    const claveAcceso = this.claveAccesoService.generate({
      fechaEmision,
      tipoComprobante: TipoComprobante.FACTURA,
      ruc: dto.emisor.ruc,
      ambiente,
      establecimiento: dto.emisor.establecimiento,
      puntoEmision: dto.emisor.puntoEmision,
      secuencial,
      tipoEmision,
    });

    const factura = await this.buildFacturaFromDto(
      dto,
      claveAcceso,
      secuencial,
      ambiente,
      tipoEmision,
    );
    return this.xmlBuilderService.buildFactura(factura);
  }

  /**
   * Genera XML firmado para debugging sin enviarlo al SRI
   */
  async generarFacturaFirmadaDebug(dto: CreateFacturaDto): Promise<{
    claveAcceso: string;
    xmlSinFirma: string;
    xmlFirmado: string;
  }> {
    this.logger.log('Generando factura firmada para debug');

    if (!dto.secuencial) {
      throw new BadRequestException('Para debug, el secuencial es obligatorio');
    }
    const secuencial = dto.secuencial.padStart(9, '0');

    const ambiente = dto.ambiente || this.base.getDefaultAmbiente();
    const tipoEmision = dto.tipoEmision || TipoEmision.NORMAL;

    const [day, month, year] = dto.fechaEmision.split('/');
    const fechaEmision = new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
    );

    const claveAcceso = this.claveAccesoService.generate({
      fechaEmision,
      tipoComprobante: TipoComprobante.FACTURA,
      ruc: dto.emisor.ruc,
      ambiente,
      establecimiento: dto.emisor.establecimiento,
      puntoEmision: dto.emisor.puntoEmision,
      secuencial,
      tipoEmision,
    });

    const factura = await this.buildFacturaFromDto(
      dto,
      claveAcceso,
      secuencial,
      ambiente,
      tipoEmision,
    );
    const xmlSinFirma = this.xmlBuilderService.buildFactura(factura);

    // Debug method - use emisor certificate from DB
    const xmlFirmado = await this.xmlSignerService.signXmlForEmisor(
      xmlSinFirma,
      dto.emisor.ruc,
    );

    return {
      claveAcceso,
      xmlSinFirma,
      xmlFirmado,
    };
  }

  /**
   * Persists factura and all related data to database
   */
  private async persistirFactura(
    dto: CreateFacturaDto,
    factura: Factura,
    emisorId: string,
    puntoEmisionId: string,
    claveAcceso: string,
    secuencial: string,
    ambiente: string,
    tipoEmision: string,
    xmlSinFirma: string,
    xmlFirmado: string,
    resultado: SriOperationResult,
    client: PoolClient,
  ): Promise<void> {
    try {
      // 1. Create main comprobante record
      const comprobante = await this.repository.createComprobante(
        {
          emisor_id: emisorId,
          punto_emision_id: puntoEmisionId,
          tipo_comprobante: TipoComprobante.FACTURA,
          ambiente,
          tipo_emision: tipoEmision,
          secuencial: secuencial,
          clave_acceso: claveAcceso,
          fecha_emision: dto.fechaEmision.split('/').reverse().join('-'),
          estado: resultado.success ? 'AUTORIZADO' : resultado.estado,
          estado_sri: resultado.estado,
          fecha_autorizacion: resultado.fechaAutorizacion,
          numero_autorizacion: resultado.numeroAutorizacion || claveAcceso,
          total_sin_impuestos: factura.infoFactura.totalSinImpuestos,
          total_descuento: factura.infoFactura.totalDescuento,
          importe_total: factura.infoFactura.importeTotal,
          propina: factura.infoFactura.propina,
          moneda: factura.infoFactura.moneda,
          receptor_tipo_identificacion: dto.comprador.tipoIdentificacion,
          receptor_identificacion: dto.comprador.identificacion,
          receptor_razon_social: dto.comprador.razonSocial,
          receptor_direccion: dto.comprador.direccion,
          receptor_email: dto.comprador.email,
          receptor_telefono: dto.comprador.telefono,
          guia_remision: dto.guiaRemision,
          id_referencia_externa: dto.referenciaExterna,
        },
        client,
      );

      this.logger.log(`Comprobante creado con ID: ${comprobante.id}`);

      // 2. Create detalles and their impuestos
      for (let i = 0; i < factura.detalles.length; i++) {
        const det = factura.detalles[i];
        const detalleRecords = await this.repository.createDetalles(
          [
            {
              comprobante_id: comprobante.id!,
              codigo_principal: det.codigoPrincipal,
              codigo_auxiliar: det.codigoAuxiliar,
              descripcion: det.descripcion,
              unidad_medida: det.unidadMedida,
              cantidad: det.cantidad,
              precio_unitario: det.precioUnitario,
              descuento: det.descuento,
              precio_total_sin_impuesto: det.precioTotalSinImpuesto,
              orden: i,
            },
          ],
          client,
        );

        const detalleId = detalleRecords[0].id!;

        // Create impuestos for this detalle
        if (det.impuestos && det.impuestos.length > 0) {
          await this.repository.createImpuestos(
            det.impuestos.map((imp) => ({
              comprobante_detalle_id: detalleId,
              codigo: imp.codigo,
              codigo_porcentaje: imp.codigoPorcentaje,
              tarifa: imp.tarifa,
              base_imponible: imp.baseImponible,
              valor: imp.valor,
            })),
            client,
          );
        }

        // Create detalles adicionales
        if (det.detallesAdicionales && det.detallesAdicionales.length > 0) {
          await this.repository.createDetallesAdicionales(
            det.detallesAdicionales.map((da) => ({
              comprobante_detalle_id: detalleId,
              nombre: da.nombre,
              valor: da.valor,
            })),
            client,
          );
        }
      }

      // 3. Create totales (totalConImpuestos)
      if (factura.infoFactura.totalConImpuestos) {
        await this.repository.createTotales(
          factura.infoFactura.totalConImpuestos.map((tot) => ({
            comprobante_id: comprobante.id!,
            codigo: tot.codigo,
            codigo_porcentaje: tot.codigoPorcentaje,
            descuento_adicional: tot.descuentoAdicional,
            base_imponible: tot.baseImponible,
            tarifa: tot.tarifa,
            valor: tot.valor,
            valor_devolucion_iva: tot.valorDevolucionIva,
          })),
          client,
        );
      }

      // 4. Create pagos
      if (factura.infoFactura.pagos) {
        await this.repository.createPagos(
          factura.infoFactura.pagos.map((pago) => ({
            comprobante_id: comprobante.id!,
            forma_pago: pago.formaPago,
            total: pago.total,
            plazo: pago.plazo,
            unidad_tiempo: pago.unidadTiempo,
          })),
          client,
        );
      }

      // 5. Save signed XML always (needed for retry), authorized only if authorized
      const fechaEmision = new Date(
        parseInt(dto.fechaEmision.split('/')[2]),
        parseInt(dto.fechaEmision.split('/')[1]) - 1,
        parseInt(dto.fechaEmision.split('/')[0]),
      );
      const xmlPaths = this.xmlStorage.saveAllXmls(
        dto.emisor.ruc,
        claveAcceso,
        fechaEmision,
        undefined, // sin_firma - not needed
        xmlFirmado, // firmado - always save for retry
        resultado.xmlAutorizado, // autorizado - only if success
      );
      await this.repository.saveXml(
        {
          comprobante_id: comprobante.id!,
          xml_firmado_path: xmlPaths.firmadoPath,
          xml_autorizado_path: xmlPaths.autorizadoPath,
        },
        client,
      );

      // 6. Create info adicional
      if (factura.infoAdicional && factura.infoAdicional.length > 0) {
        await this.repository.createInfoAdicional(
          factura.infoAdicional.map((info) => ({
            comprobante_id: comprobante.id!,
            nombre: info.nombre,
            valor: info.valor,
          })),
          client,
        );
      }

      this.logger.log(`Factura ${claveAcceso} persistida correctamente`);
    } catch (error) {
      this.logger.error(
        `CRÍTICO: Factura ${claveAcceso} autorizada por SRI pero NO persistida: ${(error as Error).message}`,
      );

      // Emitir evento de alerta para reconciliación posterior
      this.eventEmitter.emit('comprobante.persistencia_fallida', {
        claveAcceso,
        emisorRuc: dto.emisor.ruc,
        tipoComprobante: TipoComprobante.FACTURA,
        error: (error as Error).message,
        timestamp: new Date(),
      });
      throw error;
    }
  }

  /**
   * Construye objeto Factura a partir del DTO
   */
  private async buildFacturaFromDto(
    dto: CreateFacturaDto,
    claveAcceso: string,
    secuencial: string,
    ambiente: Ambiente,
    tipoEmision: TipoEmision,
  ): Promise<Factura> {
    const detalles = this.buildDetalles(dto.detalles);
    const {
      totalSinImpuestos,
      totalDescuento,
      totalConImpuestos,
      importeTotal,
    } = this.calculateTotales(detalles);

    const infoTributaria: InfoTributaria = {
      ambiente,
      tipoEmision,
      razonSocial: dto.emisor.razonSocial,
      nombreComercial: dto.emisor.nombreComercial,
      ruc: dto.emisor.ruc,
      claveAcceso,
      codDoc: TipoComprobante.FACTURA,
      estab: dto.emisor.establecimiento.padStart(3, '0'),
      ptoEmi: dto.emisor.puntoEmision.padStart(3, '0'),
      secuencial: secuencial.padStart(9, '0'),
      dirMatriz: dto.emisor.dirMatriz,
      agenteRetencion: dto.emisor.agenteRetencion,
      contribuyenteRimpe: dto.emisor.contribuyenteRimpe,
    };

    const infoFactura: InfoFactura = {
      fechaEmision: dto.fechaEmision,
      dirEstablecimiento: dto.emisor.dirEstablecimiento,
      contribuyenteEspecial: dto.emisor.contribuyenteEspecial,
      obligadoContabilidad: dto.emisor.obligadoContabilidad,
      tipoIdentificacionComprador: dto.comprador.tipoIdentificacion,
      guiaRemision: dto.guiaRemision,
      razonSocialComprador: dto.comprador.razonSocial,
      identificacionComprador: dto.comprador.identificacion,
      direccionComprador: dto.comprador.direccion,
      totalSinImpuestos,
      totalDescuento,
      totalConImpuestos,
      importeTotal,
      moneda: 'DOLAR',
      pagos: dto.pagos.map((p) => ({
        formaPago: p.formaPago,
        total: p.total,
        plazo: p.plazo,
        unidadTiempo: p.unidadTiempo,
      })),
    };

    const factura: Factura = {
      infoTributaria,
      infoFactura,
      detalles,
    };

    const infoAdicional: any[] = [];

    if (dto.comprador.email) {
      infoAdicional.push({ nombre: 'email', valor: dto.comprador.email });
    }
    if (dto.comprador.telefono) {
      infoAdicional.push({ nombre: 'telefono', valor: dto.comprador.telefono });
    }
    if (dto.comprador.direccion) {
      infoAdicional.push({
        nombre: 'direccion',
        valor: dto.comprador.direccion,
      });
    }

    if (dto.infoAdicional) {
      infoAdicional.push(...dto.infoAdicional);
    }

    // Resolución NAC-DGERCGC26-00000027: RUC del proveedor del sistema
    const infoAdicionalFinal = await this.base.injectProveedorRucInfoAdicional(infoAdicional);

    if (infoAdicionalFinal.length > 0) {
      factura.infoAdicional = infoAdicionalFinal;
    }

    return factura;
  }

  private buildDetalles(
    dtoDetalles: CreateFacturaDto['detalles'],
  ): DetalleFactura[] {
    return dtoDetalles.map((d) => {
      const subtotal = d.cantidad * d.precioUnitario;
      if (d.descuento > subtotal) {
        throw new BadRequestException(
          `Descuento (${d.descuento}) no puede ser mayor al subtotal del detalle (${subtotal})`,
        );
      }
      const precioTotalSinImpuesto = subtotal - d.descuento;

      return {
        codigoPrincipal: d.codigoPrincipal,
        codigoAuxiliar: d.codigoAuxiliar,
        descripcion: d.descripcion,
        unidadMedida: d.unidadMedida,
        cantidad: d.cantidad,
        precioUnitario: d.precioUnitario,
        descuento: d.descuento,
        precioTotalSinImpuesto,
        detallesAdicionales: d.detallesAdicionales,
        impuestos: d.impuestos.map((imp) => ({
          codigo: imp.codigo,
          codigoPorcentaje: imp.codigoPorcentaje,
          tarifa: imp.tarifa,
          baseImponible: imp.baseImponible,
          valor: imp.valor,
        })),
      };
    });
  }

  private calculateTotales(detalles: DetalleFactura[]): {
    totalSinImpuestos: number;
    totalDescuento: number;
    totalConImpuestos: TotalImpuesto[];
    importeTotal: number;
  } {
    let totalSinImpuestos = new Decimal(0);
    let totalDescuento = new Decimal(0);
    const impuestosMap = new Map<
      string,
      {
        codigo: string;
        codigoPorcentaje: string;
        tarifa: number;
        baseImponible: Decimal;
        valor: Decimal;
      }
    >();

    detalles.forEach((detalle) => {
      totalSinImpuestos = totalSinImpuestos.plus(
        new Decimal(detalle.precioTotalSinImpuesto),
      );
      totalDescuento = totalDescuento.plus(new Decimal(detalle.descuento));

      detalle.impuestos.forEach((imp) => {
        const key = `${imp.codigo}-${imp.codigoPorcentaje}`;
        const existing = impuestosMap.get(key);

        if (existing) {
          existing.baseImponible = existing.baseImponible.plus(
            new Decimal(imp.baseImponible),
          );
          existing.valor = existing.valor.plus(new Decimal(imp.valor));
        } else {
          impuestosMap.set(key, {
            codigo: imp.codigo,
            codigoPorcentaje: imp.codigoPorcentaje,
            tarifa: imp.tarifa,
            baseImponible: new Decimal(imp.baseImponible),
            valor: new Decimal(imp.valor),
          });
        }
      });
    });

    const totalConImpuestos: TotalImpuesto[] = Array.from(
      impuestosMap.values(),
    ).map((imp) => ({
      ...imp,
      baseImponible: imp.baseImponible.toDecimalPlaces(2).toNumber(),
      valor: imp.valor.toDecimalPlaces(2).toNumber(),
    }));

    const totalImpuestos = totalConImpuestos.reduce(
      (sum, imp) => sum.plus(new Decimal(imp.valor)),
      new Decimal(0),
    );
    const importeTotal = totalSinImpuestos.plus(totalImpuestos);

    return {
      totalSinImpuestos: totalSinImpuestos.toDecimalPlaces(2).toNumber(),
      totalDescuento: totalDescuento.toDecimalPlaces(2).toNumber(),
      totalConImpuestos,
      importeTotal: importeTotal.toDecimalPlaces(2).toNumber(),
    };
  }

  mapResultToResponse(result: SriOperationResult): FacturaResponseDto {
    return {
      success: result.success,
      claveAcceso: result.claveAcceso,
      estado: result.estado,
      fechaAutorizacion: result.fechaAutorizacion,
      numeroAutorizacion: result.numeroAutorizacion,
      xmlAutorizado: result.xmlAutorizado,
      mensajes: result.mensajes,
    };
  }
}
