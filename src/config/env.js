'use strict';

require('dotenv').config();

/**
 * Lee una variable de entorno obligatoria. Lanza un error claro si falta,
 * para evitar arrancar el servidor en un estado inválido.
 */
function required(name) {
  const value = process.env[name];
  if (!value || String(value).trim() === '') {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * La clave privada suele guardarse en una sola línea con "\n" literales.
 * Aquí los convertimos en saltos de línea reales.
 */
function normalizePrivateKey(key) {
  return key ? key.replace(/\\n/g, '\n') : key;
}

// Proveedor de la matriz de mantenimiento: 'local' | 'googlesheet' | 'onedrive'.
const matrixSource = optional('MATRIX_SOURCE', 'local').toLowerCase();
const VALID_SOURCES = ['local', 'googlesheet', 'onedrive'];
if (!VALID_SOURCES.includes(matrixSource)) {
  throw new Error(
    `MATRIX_SOURCE inválido: "${matrixSource}". Valores permitidos: ${VALID_SOURCES.join(', ')}.`
  );
}

const env = {
  port: parseInt(optional('PORT', '3000'), 10),

  matrixSource,

  hubspot: {
    accessToken: required('HUBSPOT_ACCESS_TOKEN'),

    // Propiedad estándar del producto con el número de parte / SKU.
    productSkuProperty: optional('HUBSPOT_PRODUCT_SKU_PROPERTY', 'hs_sku'),

    // Propiedades de frecuencia (selección Si/No) en el line item.
    frequencyProperties: {
      100: optional('HUBSPOT_FREQUENCY_100_PROPERTY', 'frec_100'),
      250: optional('HUBSPOT_FREQUENCY_250_PROPERTY', 'frec_250'),
      500: optional('HUBSPOT_FREQUENCY_500_PROPERTY', 'frec_500'),
      1000: optional('HUBSPOT_FREQUENCY_1000_PROPERTY', 'frec_1000'),
      2000: optional('HUBSPOT_FREQUENCY_2000_PROPERTY', 'frec_2000'),
      8000: optional('HUBSPOT_FREQUENCY_8000_PROPERTY', 'frec_8000'),
    },
    // Valor enviado cuando la frecuencia tiene una "X". Las demás no se envían.
    frequencyValueYes: optional('HUBSPOT_FREQUENCY_VALUE_YES', 'Si'),

    // Configuración del nuevo deal (réplica del original).
    defaultDealPipeline: required('HUBSPOT_DEFAULT_DEAL_PIPELINE'),
    defaultDealStage: optional('HUBSPOT_DEFAULT_DEAL_STAGE', ''),
    newDealNameSuffix: optional('HUBSPOT_NEW_DEAL_NAME_SUFFIX', ' - Mantenimiento'),

    // IDs de tipos de asociación (HubSpot defined).
    dealToCompanyAssociationTypeId: parseInt(optional('HUBSPOT_DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID', '5'), 10),
    dealToContactAssociationTypeId: parseInt(optional('HUBSPOT_DEAL_TO_CONTACT_ASSOCIATION_TYPE_ID', '3'), 10),
    lineItemToDealAssociationTypeId: parseInt(optional('HUBSPOT_LINE_ITEM_TO_DEAL_ASSOCIATION_TYPE_ID', '20'), 10),
  },
};

// Lista ordenada de frecuencias soportadas. Se usa en varios módulos.
env.frequencies = [100, 250, 500, 1000, 2000, 8000];

// Credenciales del proveedor seleccionado (obligatorias solo para ese proveedor).
if (matrixSource === 'local') {
  env.local = {
    excelPath: optional('LOCAL_EXCEL_PATH', './Example_Excel/Insumos JCB 2026.xlsx'),
  };
} else if (matrixSource === 'googlesheet') {
  env.google = {
    sheetId: required('GOOGLE_SHEET_ID'),
    clientEmail: required('GOOGLE_CLIENT_EMAIL'),
    privateKey: normalizePrivateKey(required('GOOGLE_PRIVATE_KEY')),
  };
} else if (matrixSource === 'onedrive') {
  env.onedrive = {
    tenantId: required('MS_TENANT_ID'),
    clientId: required('MS_CLIENT_ID'),
    clientSecret: required('MS_CLIENT_SECRET'),
    // Identificación del archivo: driveId + itemId (recomendado) o userId.
    driveId: optional('ONEDRIVE_DRIVE_ID', ''),
    userId: optional('ONEDRIVE_USER_ID', ''),
    itemId: required('ONEDRIVE_ITEM_ID'),
  };
  if (!env.onedrive.driveId && !env.onedrive.userId) {
    throw new Error('Para MATRIX_SOURCE=onedrive define ONEDRIVE_DRIVE_ID o ONEDRIVE_USER_ID.');
  }
}

module.exports = env;
