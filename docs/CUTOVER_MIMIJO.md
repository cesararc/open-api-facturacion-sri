# Checklist de corte Mimijo → Open API Facturación SRI

Orden único (sin feature flag por negocio). La consulta de RUC sigue en Olimpush.

## Prerrequisitos de la API

- [ ] Postgres, Redis y volumen persistente para `XMLS_DIR` / `CERTS_DIR`
- [ ] Migraciones aplicadas: `database/migrations/001_*.sql` … `003_*.sql`
- [ ] `SRI_EMISION_ASYNC=false`
- [ ] Contraseña del superadmin cambiada (la semilla es pública)
- [ ] Tenant Mimijo, usuarios de servicio (web + MCP) y `PROVEEDOR_RUC` creados
- [ ] `THROTTLE_EMISION_LIMIT` y `THROTTLE_LIMIT` altos (pocas IP de backends)
- [ ] `SERVE_STATIC_PDFS=false` salvo que se necesite servir `/pdfs` a propósito
- [ ] CORS: requests sin `Origin` aceptados (ya en código); `ALLOWED_ORIGINS` con la web si aplica

## Variables nuevas

### mimijoWebApp (servidor)

```
SRI_API_URL=https://<host-api>
SRI_API_EMAIL=<usuario-servicio-web>
SRI_API_PASSWORD=<secreto>
SRI_AMBIENTE=1   # 1=pruebas, 2=producción
```

### serverMCPMimijo

```
SRI_API_URL=https://<host-api>
SRI_API_EMAIL=<usuario-servicio-mcp>
SRI_API_PASSWORD=<secreto>
SRI_AMBIENTE=2   # producción en el corte
```

`OLIMPUSH_API_KEY` / `OLIMPUSH_TOKEN` se mantienen para consulta de RUC.

## Pasos

1. **Desplegar API** con lo anterior.
2. **Desplegar Web** (alta de emisor al guardar facturación). La emisión aún no cambia.
3. **Backfill en seco**
   ```bash
   cd mimijoWebApp && npm run backfill:sri:dry
   ```
4. **Backfill real** y resolver negocios que fallen
   ```bash
   cd mimijoWebApp && npm run backfill:sri
   ```
5. **Prueba en ambiente de pruebas del SRI** (`SRI_AMBIENTE=1`) con un negocio; reponer su secuencial si hace falta.
6. **Deploy del MCP** con `SRI_AMBIENTE=2` → este es el corte.
7. **Volver a correr el backfill** enseguida para alinear secuenciales.

## Vuelta atrás

- Desplegar la versión anterior del MCP en App Engine.
- Firestore conserva certificado/clave e `invoiceCounter` (el MCP nuevo los refleja) hasta la limpieza.

## Limpieza (solo tras corte estable)

```bash
cd mimijoWebApp && npx tsx scripts/cleanup-sri-secrets.ts --dry-run
cd mimijoWebApp && npx tsx scripts/cleanup-sri-secrets.ts
```

Después, en el MCP, dejar de reflejar `invoiceCounter` (buscar `reflectInvoiceCounter`).

## Diferencias visibles a propósito

- IVA exento sale con código `7` (antes `0` por defecto de Olimpush).
- RUC de cliente con dígito verificador inválido falla en la API, no en el SRI.
- "FACTURA AUTORIZADA" solo si `estado === AUTORIZADO`.

## Prueba manual sugerida (ambiente pruebas)

1. Guardar facturación en la web con un `.p12` de pruebas → verificar `facturacion.sri.emisorId`.
2. Completar una venta en Mimijo → el MCP debe dejar `facturaElectronica.generada=true` y `keyAccess` de 49 dígitos.
3. Reintentar la misma venta / `generate_electronic_invoice` → misma clave (idempotencia por `referenciaExterna`).
4. Descargar RIDE por `GET /sri/comprobantes/:clave/ride` (JWT).
