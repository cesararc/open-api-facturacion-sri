# API Facturación Electrónica SRI — Ecuador 🇪🇨

> **API REST completa para emitir, firmar y gestionar comprobantes electrónicos ante el SRI Ecuador.**  
> Facturas, Notas de Crédito/Débito, Retenciones y Guías de Remisión — en una sola integración.

[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![Node](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14+-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e)](./LICENSE)
[![Swagger](https://img.shields.io/badge/Docs-Swagger-85EA2D?logo=swagger&logoColor=black)](http://localhost:3001/api)

---

## ¿Qué hace esta API?

Integra tu sistema (ERP, POS, e-commerce, SaaS) con el **Servicio de Rentas Internas (SRI) de Ecuador** mediante un único endpoint REST. Ella se encarga de todo el flujo complejo por ti:

```
Tu sistema  →  POST /sri/emitir/factura  →  Genera XML  →  Firma XAdES-BES
            →  Envía al SRI (SOAP)       →  Obtiene autorización
            →  Genera RIDE (PDF+QR)      →  Notifica via Webhook  →  Guarda en DB
```

Sin librerías adicionales. Sin entender SOAP. Sin XML a mano. **Solo JSON.**

---

## 📋 Tabla de Contenidos

- [Por qué esta API](#-por-qué-esta-api)
- [Funcionalidades](#-funcionalidades)
- [Inicio Rápido](#-inicio-rápido)
- [Ejemplo Real](#-ejemplo-real)
- [Arquitectura](#-arquitectura)
- [API Endpoints](#-api-endpoints)
- [Variables de Entorno](#%EF%B8%8F-variables-de-entorno)
- [Docker](#-docker)
- [Autenticación y Roles](#-autenticación-y-roles)
- [Estructura del Proyecto](#-estructura-del-proyecto)
- [Scripts Disponibles](#%EF%B8%8F-scripts-disponibles)
- [Changelog](#-changelog)
- [Contribuciones](#-contribuciones)
- [Licencia](#-licencia)
- [Contacto](#-contacto)

---

## 🎯 Por qué esta API

La mayoría de soluciones de facturación electrónica para Ecuador son librerías PHP o Java que requieren integración manual con los Web Services SOAP del SRI. Esta API resuelve eso diferente:

| Característica | Esta API | Otras soluciones |
|---|---|---|
| **Lenguaje** | TypeScript / NestJS | PHP, Java, Python |
| **Tipo** | API REST completa y desplegable | Librería que debes integrar |
| **Multi-tenant** | ✅ Múltiples empresas en una instancia | ❌ |
| **Autenticación JWT** | ✅ Con roles y refresh tokens | ❌ |
| **Cola asíncrona** | ✅ BullMQ + Redis | ❌ |
| **Webhooks** | ✅ Notificaciones automáticas | ❌ |
| **RIDE (PDF)** | ✅ Plantillas Word/Excel + QR | ❌ |
| **Firma XAdES-BES** | ✅ Integrada | Manual / externa |
| **Docker** | ✅ Producción lista | Raramente |
| **Swagger UI** | ✅ Incluido | ❌ |

---

## ✨ Funcionalidades

### Comprobantes Electrónicos SRI
- 🧾 **Factura Electrónica** — tipo `01`
- 📋 **Nota de Crédito** — tipo `04`
- 📋 **Nota de Débito** — tipo `05`
- 🚚 **Guía de Remisión** — tipo `06`
- 🏦 **Comprobante de Retención** — tipo `07`

### Firma y Seguridad
- 🔐 **Firma XAdES-BES** con certificado P12 — estándar oficial del SRI
- 🔑 **Autenticación JWT** con roles (`SUPERADMIN`, `ADMIN`, `USER`)
- 🔄 **Rotación de Refresh Tokens** — sesiones seguras
- 🛡️ **Cifrado AES-256** para datos sensibles (passwords de certificados, tokens)

### Integraciones y Automatización
- ⚡ **Webhooks** — notifica tu sistema automáticamente cuando el SRI autoriza o rechaza
- 📤 **Cola BullMQ + Redis** — emisión asíncrona con reintentos automáticos
- 🌐 **Ambientes SRI** — pruebas (`celcer.sri.gob.ec`) y producción (`cel.sri.gob.ec`) configurables por variable de entorno

### Generación de Documentos
- 📄 **RIDE en PDF** — desde plantillas Word/Excel con Carbone.io
- ✍️ **Firma digital de PDFs** — con `@signpdf` y certificado P12
- 📷 **Código QR** embebido automáticamente en el RIDE

### Multi-Tenant
- 🏢 **Múltiples empresas** (tenants) en una sola instancia de API
- 🏬 **Sucursales y Puntos de Emisión** por empresa
- 🔢 **Secuenciales automáticos** por punto de emisión y tipo de comprobante

### Observabilidad
- 📊 **Health Check** en `/status` — PostgreSQL, Redis y filesystem
- 📝 **Auditoría** — log inmutable de todas las acciones sensibles
- 🔍 **Swagger UI** interactivo en `/api` con autorización JWT persistida

---

## 🚀 Inicio Rápido

### Requisitos

| Herramienta | Versión mínima |
|---|---|
| Node.js | 22+ |
| npm | 10+ |
| PostgreSQL | 14+ |
| Redis | 7+ |
| Docker *(opcional)* | 24+ |

### Instalación

```bash
# 1. Clonar el repositorio
git clone https://github.com/AngeloBarzolaVillamar/open-api-facturacion-sri.git
cd open-api-facturacion-sri

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env.development
# Edita .env.development con tu configuración (DB, Redis, JWT, etc.)

# 4. Inicializar la base de datos (solo la primera vez)
psql -U postgres -d tu_db -f database/init.sql

# 5. Aplicar migraciones (en cada actualización; es seguro repetirlo)
npm run db:migrate

# 6. Iniciar en modo desarrollo
npm run start:dev
```

> **Migraciones.** Los cambios de esquema posteriores a `init.sql` viven en `database/migrations/NNN_*.sql`. `npm run db:migrate` aplica las pendientes en orden, cada una en su transacción, y las registra en la tabla `schema_migrations`. `npm run db:migrate -- --dry-run` solo las lista. Dentro del contenedor: `docker compose exec open-api-facturacion-sri node scripts/migrate.js`.

La API estará disponible en: `http://localhost:3001`  
Documentación Swagger interactiva en: `http://localhost:3001/api`

### Con Docker (recomendado para desarrollo)

```bash
cp .env.example .env.docker
# Edita .env.docker con tu configuración

docker compose up -d --build
```

---

## ⚡ Ejemplo Real

### 1. Autenticarse

```bash
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "superadmin@openapi-sri.com", "password": "Admin123!"}'
```

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 2. Emitir una Factura Electrónica

```bash
curl -X POST http://localhost:3001/sri/emitir/factura \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TU_ACCESS_TOKEN>" \
  -d '{
    "fechaEmision": "05/05/2026",
    "referenciaExterna": "venta-000123",
    "emisor": {
      "ruc": "0924383631001",
      "razonSocial": "MI EMPRESA S.A.",
      "nombreComercial": "MI EMPRESA",
      "dirMatriz": "Guayaquil, Av. Principal 123",
      "dirEstablecimiento": "Local 1, Guayaquil",
      "establecimiento": "001",
      "puntoEmision": "001",
      "obligadoContabilidad": "SI"
    },
    "comprador": {
      "tipoIdentificacion": "05",
      "identificacion": "0926789017",
      "razonSocial": "JUAN PEREZ"
    },
    "detalles": [
      {
        "codigoPrincipal": "PROD-001",
        "descripcion": "Servicio de desarrollo de software",
        "cantidad": 1,
        "precioUnitario": 1000.00,
        "descuento": 0,
        "impuestos": [
          {
            "codigo": "2",
            "codigoPorcentaje": "4",
            "tarifa": 15,
            "baseImponible": 1000.00,
            "valor": 150.00
          }
        ]
      }
    ],
    "pagos": [{ "formaPago": "01", "total": 1150.00 }]
  }'
```

### Respuesta exitosa del SRI

```json
{
  "success": true,
  "claveAcceso": "0505202601092438363100110010010000000011234567891",
  "estado": "AUTORIZADO",
  "numeroAutorizacion": "0505202601092438363100110010010000000011234567891",
  "fechaAutorizacion": "2026-05-05T14:30:00.000Z",
  "mensajes": []
}
```

El emisor (RUC) debe existir antes en `/emisores`, con su punto de emisión y su certificado `.p12` cargado en `POST /certificates/upload-cert`. El certificado y su clave no viajan en la factura: se guardan una vez, cifrados, y la API firma con ellos.

### Emitir sin duplicar: `referenciaExterna`

Envía en `referenciaExterna` el identificador de la venta en tu sistema (máx. 100 caracteres). Si repites la llamada con la misma referencia para el mismo emisor y ambiente:

| Situación de la emisión anterior | Qué hace la API |
|---|---|
| Ya está `AUTORIZADO` | Devuelve ese mismo comprobante. No emite otro. |
| Quedó pendiente o en proceso | Consulta al SRI por esa clave de acceso (y reenvía el mismo XML si el SRI no lo conoce). No consume otro secuencial. |
| Fue rechazada por el SRI | Emite un comprobante nuevo. |

Sin `referenciaExterna` cada llamada emite un comprobante nuevo, como siempre.

---

## 🏛️ Arquitectura

```
                         ┌─────────────────────────────┐
                         │       Tu Sistema (ERP/POS)   │
                         └────────────┬────────────────┘
                                      │ REST JSON
                         ┌────────────▼────────────────┐
                         │   API Facturación SRI        │
                         │   NestJS + TypeScript        │
                         │   ┌─────────────────────┐   │
                         │   │  Módulos NestJS      │   │
                         │   │  - /auth  (JWT)      │   │
                         │   │  - /sri   (SRI)      │   │
                         │   │  - /webhooks         │   │
                         │   │  - /pdf   (Carbone)  │   │
                         │   │  - /signature (P12)  │   │
                         │   └──────────┬──────────┘   │
                         └─────────────┼───────────────┘
              ┌──────────┬─────────────┼──────────┬──────────┐
              ▼          ▼             ▼          ▼          ▼
        PostgreSQL     Redis        SRI SOAP   Carbone     Webhook
         (datos)      (cola/       (celcer/    (PDFs)    (tu URL)
                       caché)      cel.sri)
```

### Flujo de emisión asíncrona

```
POST /sri/emitir/factura
        │
        ▼
  Validación DTO ──▶ Firma XAdES-BES ──▶ Envío SOAP SRI
        │                                      │
        ▼                                      ▼
  Guarda en DB                        ¿Autorizado?
        │                              │         │
        ▼                             SÍ         NO
  Encola BullMQ                        │         │
        │                         Genera RIDE  Reintento
        ▼                         (PDF + QR)   automático
  Procesador Redis                     │
        │                         Dispara Webhook
        ▼                         a tu sistema
  Webhook → Tu URL
```

---

## 🔌 API Endpoints

*Documentación completa e interactiva en `/api` (Swagger UI).*

### Autenticación

| Método | Endpoint | Descripción |
| ------ | -------- | ----------- |
| `POST` | `/auth/login` | Iniciar sesión — retorna `accessToken` + `refreshToken` |
| `POST` | `/auth/refresh` | Renovar tokens con rotación automática |
| `POST` | `/auth/register` | Crear usuario *(requiere rol SUPERADMIN)* |
| `GET` | `/auth/me` | Perfil del usuario autenticado |
| `PATCH` | `/auth/change-password` | Cambiar contraseña *(cierra todas las sesiones del usuario)* |
| `POST` | `/auth/logout` | Cerrar sesión *(invalida todos los tokens del usuario)* |

### Comprobantes Electrónicos SRI

| Método | Endpoint | Descripción |
| ------ | -------- | ----------- |
| `POST` | `/sri/emitir/factura` | Emitir Factura Electrónica |
| `POST` | `/sri/emitir/nota-credito` | Emitir Nota de Crédito |
| `POST` | `/sri/emitir/nota-debito` | Emitir Nota de Débito |
| `POST` | `/sri/emitir/retencion` | Emitir Comprobante de Retención |
| `POST` | `/sri/emitir/guia-remision` | Emitir Guía de Remisión |
| `POST` | `/sri/preview/factura` | Generar el XML sin firmar ni enviar |
| `GET` | `/sri/comprobantes` | Listar comprobantes *(paginado, filtrable)* |
| `GET` | `/sri/comprobantes/:claveAcceso` | Detalle de un comprobante |
| `GET` | `/sri/comprobantes/:claveAcceso/xml` | Descargar XML autorizado |
| `GET` | `/sri/comprobantes/:claveAcceso/ride` | Descargar RIDE (PDF) |
| `GET` | `/sri/autorizar/:claveAcceso` | Consultar autorización en el SRI |
| `GET` | `/sri/verificar/:claveAcceso` | Consultar estado en SRI en tiempo real |
| `POST` | `/sri/sincronizar` | Sincronizar comprobantes pendientes |
| `POST` | `/sri/comprobantes/:claveAcceso/reintentar` | Reintentar comprobante fallido |
| `PATCH` | `/sri/comprobantes/:claveAcceso/anular` | Anular comprobante localmente |

### Catálogos SRI

| Método | Endpoint | Descripción |
| ------ | -------- | ----------- |
| `GET` | `/catalogos/impuestos` | Tarifas IVA vigentes (0%, 5%, 15%) |
| `GET` | `/catalogos/retenciones` | Códigos de retención Renta e IVA |
| `GET` | `/catalogos/formas-pago` | Formas de pago SRI |
| `GET` | `/catalogos/tipos-identificacion` | Tipos de identificación |
| `GET` | `/catalogos/documentos-sustento` | Documentos sustento |
| `GET` | `/catalogos/motivos-traslado` | Motivos traslado (Guía de Remisión) |

### Webhooks

| Método | Endpoint | Descripción |
| ------ | -------- | ----------- |
| `GET` | `/webhooks` | Listar webhooks del Tenant |
| `POST` | `/webhooks` | Registrar URL de notificación |
| `GET` | `/webhooks/logs` | Historial de notificaciones *(paginado)* |

### Generación de RIDE (PDF)

| Método | Endpoint | Descripción |
| ------ | -------- | ----------- |
| `POST` | `/generate-pdf/download/:templateId` | Generar y descargar PDF |
| `POST` | `/generate-pdf/save/:templateId` | Generar y guardar en servidor |
| `POST` | `/generate-pdf/with-images/download/:templateId` | PDF con imágenes |
| `GET` | `/generate-pdf/list/:type` | Listar PDFs generados |

### Firma Digital

| Método | Endpoint | Descripción |
| ------ | -------- | ----------- |
| `POST` | `/signature/sign-pdf/:fileName` | Firmar PDF existente con P12 |
| `POST` | `/signature/generate-sign-pdf/:templateId` | Generar y firmar en un paso |
| `POST` | `/signature/generate-sign-pdf/save/:templateId` | Generar, firmar y guardar |

### Certificados P12

| Método | Endpoint | Descripción |
| ------ | -------- | ----------- |
| `GET` | `/certificates/list-certs` | Listar certificados de tu tenant |
| `POST` | `/certificates/upload-cert` | Subir el `.p12` de un emisor (valida clave y vigencia antes de guardar) |
| `DELETE` | `/certificates/delete-cert/:fileName` | Eliminar certificado |
| `GET` | `/certificates/cert-info/:fileName` | Ver datos del certificado |
| `POST` | `/certificates/validate-cert/:fileName` | Verificar clave y expiración |

El certificado se guarda en la base de datos (cifrada su clave con AES-256-GCM) y la API firma desde ahí; el archivo `<RUC>.p12` en `CERTS_DIR` es solo una copia. Cada tenant ve y administra únicamente los certificados de sus emisores.

### Templates y Gestión

| Método | Endpoint | Descripción |
| ------ | -------- | ----------- |
| `GET` | `/templates` | Listar plantillas RIDE |
| `POST` | `/templates/upload` | Subir plantilla (.docx / .xlsx) |
| `DELETE` | `/templates/:fileName` | Eliminar plantilla |
| `GET` | `/images/list` | Listar imágenes |
| `POST` | `/images/upload` | Subir imagen |
| `GET` | `/status` | Health check del servidor |

---

## ⚙️ Variables de Entorno

Copia `.env.example` como punto de partida. Las variables marcadas con ✅ son obligatorias.

### Servidor

| Variable | Descripción | Ejemplo |
| -------- | ----------- | ------- |
| `PORT` ✅ | Puerto de la API | `3001` |
| `PUBLIC_URL` ✅ | URL pública de la API | `https://api.tudominio.com` |
| `NODE_ENV` | Entorno de ejecución | `production` |

### Base de Datos (PostgreSQL)

| Variable | Descripción | Ejemplo |
| -------- | ----------- | ------- |
| `DB_HOST` ✅ | Host de PostgreSQL | `localhost` |
| `DB_PORT` ✅ | Puerto | `5432` |
| `DB_NAME` ✅ | Nombre de la BD | `db_sri` |
| `DB_USER` ✅ | Usuario | `postgres` |
| `DB_PASSWORD` ✅ | Contraseña | `tu-password` |
| `DB_POOL_MAX` | Conexiones máximas | `10` |
| `DB_SSL` | Conectar con TLS. Con `true` se **verifica** el certificado del servidor | `false` |
| `DB_SSL_CA` | CA del servidor: contenido PEM (en una línea con `\n`) o ruta al archivo | *(vacío)* |
| `DB_SSL_REJECT_UNAUTHORIZED` | `false` cifra sin verificar el certificado. Úsalo solo si no puedes configurar `DB_SSL_CA` | `true` |

La API **no arranca** si no logra conectarse a PostgreSQL.

### Redis (Cola y Caché)

| Variable | Descripción | Default |
| -------- | ----------- | ------- |
| `REDIS_HOST` ✅ | Host de Redis | `localhost` |
| `REDIS_PORT` | Puerto | `6379` |
| `REDIS_PASSWORD` | Contraseña | *(vacío)* |
| `CACHE_TTL_SECONDS` | TTL del caché | `300` |

### Seguridad

| Variable | Descripción | Ejemplo |
| -------- | ----------- | ------- |
| `JWT_SECRET` ✅ | Clave JWT (32+ chars) | `super-secret-32chars!!` |
| `ENCRYPTION_KEY` ✅ | Clave AES-256 (32 chars) | `encryption-key-32chars!!` |
| `ENCRYPTION_SALT` ✅ | Salt de cifrado | `salt-value` |
| `ALLOWED_ORIGINS` | Orígenes de navegador permitidos (CORS). Las llamadas de servidor a servidor, sin cabecera `Origin`, no dependen de esta lista: las protege el JWT | `https://app.tudominio.com` |
| `THROTTLE_LIMIT` | Peticiones por minuto y por IP | `100` |
| `THROTTLE_EMISION_LIMIT` | Facturas por minuto y por IP en `POST /sri/emitir/factura`. Súbelo si tus clientes son backends que salen por pocas IP | `10` |
| `SERVE_STATIC_PDFS` | `true` publica `PDFS_DIR` en `/pdfs` **sin autenticación**. El RIDE no lo necesita | `false` |

> No cambies `ENCRYPTION_KEY` ni `ENCRYPTION_SALT` con datos ya guardados: las claves de los certificados dejarían de poder leerse.

### SRI Ecuador

| Variable | Descripción | Valores |
| -------- | ----------- | ------- |
| `SRI_ENVIRONMENT` ✅ | Ambiente del SRI | `development` / `production` |
| `SRI_REQUEST_DELAY_MS` | Rate limit hacia SRI | `150` |
| `SRI_MAX_RETRIES` | Reintentos por comprobante | `3` |
| `SRI_EMISION_ASYNC` | `false`: `POST /sri/emitir/*` espera al SRI y responde con el resultado. `true`: encola y responde `EN_COLA` | `false` |

### RIDE / Carbone

| Variable | Descripción | Ejemplo |
| -------- | ----------- | ------- |
| `CARBONE_API` ✅ | URL del servidor Carbone | `http://carbone-server:3000` |
| `CARBONE_CONVERT_TO` | Formato de salida | `pdf` |

---

## 🐳 Docker

### Desarrollo local

```bash
# Levantar API + Redis con hot-reload
docker compose up -d --build

# Ver logs
docker compose logs -f

# Detener
docker compose down
```

### Producción (servidor)

```bash
# En tu servidor, crea la estructura
mkdir -p /opt/api-facturacion-sri
cd /opt/api-facturacion-sri

# Copia docker-compose.prod.yml y crea .env.docker
# Luego descarga y levanta la imagen
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Ver [DEPLOYMENT.md](./DEPLOYMENT.md) para la guía completa con Nginx y SSL.

---

## 👑 Autenticación y Roles

El sistema incluye seguridad JWT con tres niveles de acceso:

| Rol | Permisos |
|-----|----------|
| `SUPERADMIN` | Acceso total. Crea tenants y usuarios. |
| `ADMIN` | Gestiona su tenant: emisores, comprobantes, webhooks. |
| `USER` | Emite comprobantes dentro de su tenant. |

### Credenciales iniciales

Al ejecutar `database/init.sql` se crea el superadmin:

```
Email:     superadmin@openapi-sri.com
Password:  Admin123!
```

> ⚠️ **Cambia la contraseña inmediatamente** en producción usando `PATCH /auth/change-password`.

### Sesiones

`PATCH /auth/change-password` y `POST /auth/logout` invalidan **todos** los tokens del usuario (access y refresh), en todos los dispositivos. Si varios servicios comparten un mismo usuario, no llames a `logout` desde uno de ellos: cerrarías la sesión de los demás.

---

## 📁 Estructura del Proyecto

```
open-api-facturacion-sri/
├── src/
│   ├── common/
│   │   ├── cache/            # Módulo Redis Cache
│   │   ├── filters/          # Filtros globales de excepciones
│   │   ├── interceptors/     # Interceptor de auditoría
│   │   ├── queues/           # Configuración BullMQ
│   │   └── services/         # Encryption, Audit
│   ├── config/
│   │   └── configuration.ts  # Configuración centralizada tipada
│   ├── database/             # Pool PostgreSQL
│   └── modules/
│       ├── auth/             # JWT, guards, estrategias
│       ├── certificate/      # Gestión de certificados P12
│       ├── document/         # Generación multi-formato
│       ├── emisores/         # Empresas emisoras
│       ├── image/            # Gestión de imágenes
│       ├── pdf/              # Generación de PDFs (Carbone)
│       ├── puntos-emision/   # Sucursales y puntos de emisión
│       ├── signature/        # Firma digital de PDFs
│       ├── sri/              # ⭐ Módulo principal SRI
│       │   ├── dto/          # Validación de todos los comprobantes
│       │   ├── services/     # Clave de acceso, XML, SOAP, XAdES
│       │   └── processors/   # Procesador BullMQ
│       ├── status/           # Health checks
│       ├── template/         # Plantillas Carbone
│       ├── tenants/          # Multi-tenancy
│       └── webhooks/         # Sistema de notificaciones
├── database/
│   ├── init.sql              # Esquema PostgreSQL inicial
│   └── migrations/           # Cambios de esquema numerados (npm run db:migrate)
├── scripts/
│   └── migrate.js            # Aplica las migraciones pendientes
├── Collection/
│   └── Api_Facturacion_Sri.json  # Colección Postman lista para importar
├── docs/                     # Documentación técnica por módulo
├── Dockerfile                # Imagen multi-stage optimizada
├── docker-compose.yml        # Desarrollo local
├── docker-compose.prod.yml   # Despliegue en servidor
├── DEPLOYMENT.md             # Guía de despliegue con Nginx
├── CHANGELOG.md              # Historial de versiones y roadmap
└── CONTRIBUTING.md           # Guía para contribuir
```

---

## 🛠️ Scripts Disponibles

| Comando | Descripción |
| ------- | ----------- |
| `npm run start:dev` | Desarrollo con hot-reload |
| `npm run start:prod` | Producción |
| `npm run build` | Compilar TypeScript |
| `npm run lint` | ESLint con auto-fix |
| `npm run lint:check` | ESLint sin modificar archivos (el que usa CI) |
| `npm run typecheck` | Verificar tipos sin compilar |
| `npm run db:migrate` | Aplicar migraciones pendientes (`-- --dry-run` para solo listarlas) |
| `npm run format` | Prettier |
| `npm run test` | Tests unitarios |
| `npm run test:cov` | Tests con cobertura |
| `npm run test:e2e` | Tests end-to-end |
| `npm run docker:up` | Levantar con docker-compose |
| `npm run docker:dev` | Docker en modo desarrollo |
| `npm run docker:push` | Build y publicar a Docker Hub |
| `npm run docker:logs` | Ver logs del contenedor |

---

## 📋 Changelog

Ver [CHANGELOG.md](./CHANGELOG.md) para el historial completo y el **roadmap de próximas versiones** (Dashboard Web, reportes, 2FA, facturación masiva, métricas Prometheus).

---

## 🤝 Contribuciones

Las contribuciones son bienvenidas. Consulta la guía completa en [CONTRIBUTING.md](./CONTRIBUTING.md).

En resumen:

1. Haz un **fork** del repositorio.
2. Crea una rama descriptiva: `git checkout -b feature/liquidacion-compra`.
3. Haz commit siguiendo [Conventional Commits](https://www.conventionalcommits.org/es/): `git commit -m 'feat(sri): ...'`.
4. Sube tu rama y abre un **Pull Request** / **Merge Request**.

---

## 📄 Licencia

Licencia **MIT** — Open Source. Libre para usar, modificar y distribuir.  
Ver [LICENSE](./LICENSE) para más detalles.

---

## 📬 Contacto

- **Autor:** Angelo Michelle Barzola Villamar
- **Correo:** [angelobarzola05@gmail.com](mailto:angelobarzola05@gmail.com)
- **GitHub:** [AngeloBarzolaVillamar/open-api-facturacion-sri](https://github.com/AngeloBarzolaVillamar/open-api-facturacion-sri)
- **GitLab:** [angelosecu789/api-facturacion-electronica-sri](https://gitlab.com/angelosecu789/api-facturacion-electronica-sri)
- **Minka Gob Ec:** [angelo_barzola/api-facturacion-electronica-sri](https://minka.gob.ec/angelo_barzola/api-facturacion-electronica-sri)

---

<p align="center">
  Hecho con ❤️ en Ecuador 🇪🇨 — Si este proyecto te ayuda, dale una ⭐ en GitHub
</p>
