# hubspot-maintenance-line-items

API en Node.js + Express que, a partir de un Deal de HubSpot, **crea un nuevo Deal de
mantenimiento** (réplica del original) y le carga los **line items** definidos en una
**matriz de mantenimiento**.

El flujo lo dispara un workflow de HubSpot que llama al endpoint pasando únicamente el `dealId`.

## ¿Qué hace?

1. Recibe un `dealId`.
2. Lee el deal original en HubSpot (owner + empresas + contactos + line items).
3. Obtiene el `hs_sku` de los productos de esos line items.
4. Busca la **hoja** de la matriz cuyo **nombre coincide** con un `hs_sku`
   (ej. `hs_sku = THL 540-140` → hoja `THL 540-140`).
5. Lee la tabla de esa hoja (columna `# PARTE`, descripción y las frecuencias
   `100, 250, 500, 1000, 2000, 8000`).
6. Crea un **nuevo deal** replicando el original: mismo owner, mismas empresas y contactos,
   nombre derivado del original y pipeline por defecto (configurable).
7. Por cada fila con `# Parte`, busca el producto en HubSpot por `hs_sku` y crea un line item
   asociado al **nuevo deal**, marcando como `Si` solo las frecuencias con `X`.
8. Devuelve un resumen del proceso.

## Fuente de la matriz (configurable)

La matriz puede leerse de **tres** formas, seleccionadas con la variable `MATRIX_SOURCE`:

| `MATRIX_SOURCE` | Fuente | Credenciales necesarias |
| --- | --- | --- |
| `local` | Archivo `.xlsx` en disco (usa `exceljs`) | `LOCAL_EXCEL_PATH` |
| `googlesheet` | Google Sheets (usa `googleapis`) | `GOOGLE_SHEET_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` |
| `onedrive` | OneDrive/SharePoint vía Microsoft Graph | `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `ONEDRIVE_ITEM_ID` + (`ONEDRIVE_DRIVE_ID` o `ONEDRIVE_USER_ID`) |

Solo se exigen las credenciales del proveedor seleccionado.

## Requisitos

- Node.js 18+ (probado con Node 24).
- Una **Private App** de HubSpot con scopes de lectura/escritura sobre deals, line items,
  products, companies y contacts.
- Según la fuente: acceso al archivo local, una cuenta de servicio de Google, o una app
  registrada en Entra ID (Azure AD) con permiso `Files.Read.All`/`Sites.Read.All` para Graph.

## Instalación

```bash
npm install
cp .env.example .env
# completar las variables en .env
```

## Configuración (.env)

Ver [`.env.example`](.env.example). Variables principales:

| Variable | Descripción |
| --- | --- |
| `PORT` | Puerto HTTP (por defecto 3000). |
| `MATRIX_SOURCE` | Fuente de la matriz: `local` \| `googlesheet` \| `onedrive`. |
| `LOCAL_EXCEL_PATH` | Ruta al `.xlsx` cuando `MATRIX_SOURCE=local`. |
| `GOOGLE_SHEET_ID` / `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` | Credenciales de Google Sheets. |
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | App de Microsoft Graph (client credentials). |
| `ONEDRIVE_DRIVE_ID` (o `ONEDRIVE_USER_ID`) + `ONEDRIVE_ITEM_ID` | Ubicación del archivo en OneDrive. |
| `HUBSPOT_ACCESS_TOKEN` | Token de la Private App de HubSpot. |
| `HUBSPOT_PRODUCT_SKU_PROPERTY` | Propiedad del producto con el número de parte (por defecto `hs_sku`). |
| `HUBSPOT_FREQUENCY_100_PROPERTY` … `_8000_PROPERTY` | Propiedades Si/No de frecuencia del line item (`frec_100`…`frec_8000`). |
| `HUBSPOT_FREQUENCY_VALUE_YES` | Valor enviado cuando hay `X` (por defecto `Si`). Las demás no se envían. |
| `HUBSPOT_DEFAULT_DEAL_PIPELINE` | Pipeline donde se crea el nuevo deal (obligatorio). |
| `HUBSPOT_DEFAULT_DEAL_STAGE` | Etapa del nuevo deal. Si se deja vacía, se usa la primera del pipeline. |
| `HUBSPOT_NEW_DEAL_NAME_SUFFIX` | Sufijo para el nombre del nuevo deal (por defecto ` - Mantenimiento`). |
| `HUBSPOT_DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID` | ID de asociación deal→company (HubSpot defined, por defecto `5`). |
| `HUBSPOT_DEAL_TO_CONTACT_ASSOCIATION_TYPE_ID` | ID de asociación deal→contact (por defecto `3`). |
| `HUBSPOT_LINE_ITEM_TO_DEAL_ASSOCIATION_TYPE_ID` | ID de asociación line_item→deal (por defecto `20`). |

### Propiedades personalizadas necesarias en HubSpot

- **Line item:** las 6 propiedades de frecuencia (`frec_100`, `frec_250`, `frec_500`,
  `frec_1000`, `frec_2000`, `frec_8000`), de tipo selección Si/No.
- **Product:** el número de parte en `hs_sku` (o la propiedad que definas en
  `HUBSPOT_PRODUCT_SKU_PROPERTY`).

## Ejecución

```bash
npm run dev   # desarrollo con nodemon
npm start     # producción
```

## Endpoint

### `POST /api/maintenance/generate-line-items`

Body:

```json
{ "dealId": "123456789" }
```

Respuesta:

```json
{
  "success": true,
  "dealId": "123456789",
  "sourceSku": "THL 540-140",
  "sheetName": "THL 540-140",
  "newDealId": "987654321",
  "processedRows": 21,
  "createdLineItems": 20,
  "productsNotFound": [
    { "partNumber": "TALLER", "description": "GRASA HP ESPECIAL (CONDICIONAL)" }
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
- Deal sin line items asociados → `422`.
- Sin `hs_sku` obtenible de los productos → `422`.
- Ningún `hs_sku` coincide con una hoja de la matriz → `404`.
- Fila sin `# Parte` → se ignora. La lectura se corta al llegar a la sección `NOTA:`.
- Producto inexistente en HubSpot → se registra en `productsNotFound` y el proceso continúa.
- Cada fila genera su propio line item (un mismo SKU puede repetirse con frecuencias distintas).

## Estructura

```
src/
  app.js                       # configuración de Express y manejo de errores
  server.js                    # arranque del servidor
  config/env.js                # variables de entorno centralizadas
  routes/                      # rutas Express
  controllers/                 # validación de request y respuesta HTTP
  services/
    maintenance.service.js     # orquestación del flujo
    hubspot.service.js         # comunicación con HubSpot
    matrix.service.js          # factory de proveedor + parser de la matriz
    local-excel.service.js     # proveedor: archivo .xlsx local (exceljs)
    google-sheets.service.js   # proveedor: Google Sheets (googleapis)
    onedrive.service.js        # proveedor: OneDrive/Graph (axios)
  utils/                       # logger y normalización de texto
  errors/app-error.js          # error de aplicación controlado
```

## Notas

- La lectura de la hoja es tolerante: el encabezado abarca dos filas (la etiqueta `FRECUENCIA`
  arriba y los valores `100/250/500/1000/2000/8000` debajo). El parser localiza la fila de
  frecuencias y detecta las columnas de `# Parte`/`Descripción` en esa fila o la superior.
- Los tres proveedores exponen la misma interfaz (`getSheetNames`, `getSheetValues`) y devuelven
  una matriz 2D, por lo que el parser es común a todos.
- No se incluyen secretos: todo se configura por variables de entorno.
