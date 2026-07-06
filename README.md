# hubspot-maintenance-line-items

API en Node.js + Express que genera **line items de mantenimiento** dentro de un Deal de HubSpot
a partir de una **matriz de mantenimiento** almacenada en Google Sheets.

El flujo lo dispara un workflow de HubSpot que llama al endpoint pasando únicamente el `dealId`.

## ¿Qué hace?

1. Recibe un `dealId`.
2. Consulta los line items asociados al deal en HubSpot.
3. Obtiene el **código de máquina** desde esos line items.
4. Recorre todas las hojas del Google Sheet buscando ese código de máquina.
5. En la hoja encontrada, detecta dinámicamente las columnas `DESCRIPCION`, `# PARTE` y las
   frecuencias `250, 500, 1000, 2000, 3000, 5000`.
6. Por cada fila con `# Parte`, busca el producto en HubSpot por su número de parte.
7. Crea un line item asociado al deal, marcando cada frecuencia como `Si`/`No` según las `X`.
8. Evita duplicados y devuelve un resumen del proceso.

## Requisitos

- Node.js 18+ (probado con Node 24).
- Una **Private App** de HubSpot con scopes de lectura/escritura sobre deals, line items y products.
- Una **cuenta de servicio** de Google con acceso de lectura al Google Sheet.

## Instalación

```bash
npm install
cp .env.example .env
# completar las variables en .env
```

## Configuración (.env)

| Variable | Descripción |
| --- | --- |
| `PORT` | Puerto HTTP (por defecto 3000). |
| `HUBSPOT_ACCESS_TOKEN` | Token de la Private App de HubSpot. |
| `HUBSPOT_MACHINE_CODE_PROPERTY` | Propiedad del **line item** con el código de máquina. |
| `HUBSPOT_PRODUCT_PART_NUMBER_PROPERTY` | Propiedad del **producto** con el número de parte. |
| `HUBSPOT_FREQUENCY_250_PROPERTY` … `_5000_PROPERTY` | Propiedades Si/No de frecuencia en el line item. |
| `HUBSPOT_FREQUENCY_VALUE_YES` / `_NO` | Valores enviados cuando hay/no hay `X` (por defecto `Si`/`No`). |
| `HUBSPOT_MAINTENANCE_GENERATED_PROPERTY` | Marca que el line item fue creado por este proceso. |
| `HUBSPOT_MAINTENANCE_SOURCE_MACHINE_CODE_PROPERTY` | Código de máquina origen guardado en el line item. |
| `HUBSPOT_MAINTENANCE_PART_NUMBER_PROPERTY` | Número de parte guardado en el line item. |
| `HUBSPOT_LINE_ITEM_TO_DEAL_ASSOCIATION_TYPE_ID` | ID del tipo de asociación line_item→deal (HubSpot defined, por defecto `20`). |
| `GOOGLE_SHEET_ID` | ID del spreadsheet (en la URL entre `/d/` y `/edit`). |
| `GOOGLE_CLIENT_EMAIL` | Email de la cuenta de servicio. |
| `GOOGLE_PRIVATE_KEY` | Clave privada de la cuenta de servicio (con `\n` literales, entre comillas). |

> **Importante:** comparte el Google Sheet con el `GOOGLE_CLIENT_EMAIL` (permiso de lector).

### Propiedades personalizadas necesarias en HubSpot

- **Line item:** la propiedad de código de máquina, las 6 propiedades de frecuencia (selección Si/No)
  y las 3 propiedades de control de duplicados (`maintenance_generated`, `maintenance_source_machine_code`,
  `maintenance_part_number`).
- **Product:** la propiedad de número de parte (`numero_parte`).

## Ejecución

```bash
npm run dev   # desarrollo con nodemon
npm start     # producción
```

## Endpoint

### `POST /api/maintenance/generate-line-items`

Body:

```json
{
  "dealId": "123456789"
}
```

Respuesta:

```json
{
  "success": true,
  "dealId": "123456789",
  "codigoMaquina": "123123sdfs",
  "sheetName": "MINICARGADOR SSL190",
  "processedRows": 15,
  "createdLineItems": 13,
  "skippedDuplicates": 1,
  "productsNotFound": [
    { "partNumber": "4001/1805E", "description": "ACEITE CAJA DE CADENA" }
  ],
  "errors": []
}
```

Ejemplo con curl:

```bash
curl -X POST http://localhost:3000/api/maintenance/generate-line-items \
  -H "Content-Type: application/json" \
  -d '{"dealId":"123456789"}'
```

También existe `GET /health` para healthcheck.

## Reglas de negocio implementadas

- `dealId` ausente → `400`.
- Deal inexistente → `404`.
- Sin line items asociados → error controlado `422`.
- Sin código de máquina en los line items → error controlado `422`.
- Sin hoja que coincida con el código de máquina → `404`.
- Fila sin `# Parte` → se ignora.
- Producto inexistente en HubSpot → se registra en `productsNotFound` y el proceso continúa.
- Prevención de duplicados por `maintenance_source_machine_code` + `maintenance_part_number`.

## Estructura

```
src/
  app.js                  # configuración de Express y manejo de errores
  server.js               # arranque del servidor
  config/env.js           # variables de entorno centralizadas
  routes/                 # rutas Express
  controllers/            # validación de request y respuesta HTTP
  services/
    maintenance.service.js   # orquestación del flujo
    hubspot.service.js       # comunicación con HubSpot
    google-sheets.service.js # lectura tolerante de Google Sheets
  utils/                  # logger y normalización de texto
  errors/app-error.js     # error de aplicación controlado
```

## Notas

- La lectura del Sheet es tolerante a títulos, encabezados y filas vacías: localiza la fila de
  encabezados buscando `# Parte` + alguna columna de frecuencia, y detecta el código de máquina
  tanto por coincidencia directa como por etiqueta cercana (`Codigo Maquina`).
- Si el ID de asociación line_item→deal de tu portal difiere de `20`, ajústalo en
  `HUBSPOT_LINE_ITEM_TO_DEAL_ASSOCIATION_TYPE_ID`.
- No se incluyen secretos: todo se configura por variables de entorno.
