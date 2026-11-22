import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateFacturaDto } from './factura.dto';

/**
 * Valida el DTO con las mismas opciones que el ValidationPipe global
 * (whitelist + forbidNonWhitelisted), que es lo que ve quien llama a la API.
 */
async function errores(payload: Record<string, any>): Promise<string[]> {
  const result = await validate(plainToInstance(CreateFacturaDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flatten = (errs: ValidationError[], path = ''): string[] =>
    errs.flatMap((e) => [
      ...Object.values(e.constraints ?? {}).map(
        (m) => `${path}${e.property}: ${m}`,
      ),
      ...flatten(e.children ?? [], `${path}${e.property}.`),
    ]);
  return flatten(result);
}

function facturaBase(): Record<string, any> {
  return {
    fechaEmision: '07/02/2026',
    emisor: {
      ruc: '0924383631001',
      razonSocial: 'Negocio Test',
      dirMatriz: 'Quito',
      establecimiento: '001',
      puntoEmision: '001',
      obligadoContabilidad: 'NO',
    },
    comprador: {
      tipoIdentificacion: '07',
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
            codigoPorcentaje: '10',
            tarifa: 13,
            baseImponible: 10,
            valor: 1.3,
          },
        ],
      },
    ],
    pagos: [{ formaPago: '01', total: 11.3 }],
  };
}

describe('CreateFacturaDto', () => {
  it('acepta la factura base (incluye IVA código 10)', async () => {
    expect(await errores(facturaBase())).toEqual([]);
  });

  describe('emisor.contribuyenteRimpe', () => {
    it.each([
      'CONTRIBUYENTE RÉGIMEN RIMPE',
      'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE',
    ])('acepta la leyenda "%s"', async (leyenda) => {
      const payload = facturaBase();
      payload.emisor.contribuyenteRimpe = leyenda;

      expect(await errores(payload)).toEqual([]);
    });

    it('rechaza cualquier otro texto', async () => {
      const payload = facturaBase();
      payload.emisor.contribuyenteRimpe = 'NEGOCIO POPULAR';

      const errs = await errores(payload);

      expect(errs).toHaveLength(1);
      expect(errs[0]).toContain('emisor.contribuyenteRimpe');
    });

    it('es opcional', async () => {
      const payload = facturaBase();
      delete payload.emisor.contribuyenteRimpe;

      expect(await errores(payload)).toEqual([]);
    });
  });

  describe('referenciaExterna', () => {
    it('acepta un id de hasta 100 caracteres', async () => {
      expect(
        await errores({ ...facturaBase(), referenciaExterna: 'a'.repeat(100) }),
      ).toEqual([]);
    });

    it('rechaza más de 100 caracteres (límite de la columna)', async () => {
      const errs = await errores({
        ...facturaBase(),
        referenciaExterna: 'a'.repeat(101),
      });

      expect(errs.some((e) => e.startsWith('referenciaExterna'))).toBe(true);
    });

    it('rechaza cadena vacía y valores que no son texto', async () => {
      expect(
        await errores({ ...facturaBase(), referenciaExterna: '' }),
      ).not.toEqual([]);
      expect(
        await errores({ ...facturaBase(), referenciaExterna: 123 }),
      ).not.toEqual([]);
    });
  });

  it('sigue rechazando campos desconocidos', async () => {
    const errs = await errores({ ...facturaBase(), campoInventado: 'x' });

    expect(errs.some((e) => e.startsWith('campoInventado'))).toBe(true);
  });
});
