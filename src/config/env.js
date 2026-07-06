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

const env = {
  port: parseInt(optional('PORT', '3000'), 10),

  hubspot: {
    accessToken: required('HUBSPOT_ACCESS_TOKEN'),
    machineCodeProperty: optional('HUBSPOT_MACHINE_CODE_PROPERTY', 'codigo_maquina'),
    productPartNumberProperty: optional('HUBSPOT_PRODUCT_PART_NUMBER_PROPERTY', 'numero_parte'),
    frequencyProperties: {
      250: optional('HUBSPOT_FREQUENCY_250_PROPERTY', 'frecuencia_250'),
      500: optional('HUBSPOT_FREQUENCY_500_PROPERTY', 'frecuencia_500'),
      1000: optional('HUBSPOT_FREQUENCY_1000_PROPERTY', 'frecuencia_1000'),
      2000: optional('HUBSPOT_FREQUENCY_2000_PROPERTY', 'frecuencia_2000'),
      3000: optional('HUBSPOT_FREQUENCY_3000_PROPERTY', 'frecuencia_3000'),
      5000: optional('HUBSPOT_FREQUENCY_5000_PROPERTY', 'frecuencia_5000'),
    },
    frequencyValueYes: optional('HUBSPOT_FREQUENCY_VALUE_YES', 'Si'),
    frequencyValueNo: optional('HUBSPOT_FREQUENCY_VALUE_NO', 'No'),
    maintenanceGeneratedProperty: optional('HUBSPOT_MAINTENANCE_GENERATED_PROPERTY', 'maintenance_generated'),
    maintenanceSourceMachineCodeProperty: optional('HUBSPOT_MAINTENANCE_SOURCE_MACHINE_CODE_PROPERTY', 'maintenance_source_machine_code'),
    maintenancePartNumberProperty: optional('HUBSPOT_MAINTENANCE_PART_NUMBER_PROPERTY', 'maintenance_part_number'),
    lineItemToDealAssociationTypeId: parseInt(optional('HUBSPOT_LINE_ITEM_TO_DEAL_ASSOCIATION_TYPE_ID', '20'), 10),
  },

  google: {
    sheetId: required('GOOGLE_SHEET_ID'),
    clientEmail: required('GOOGLE_CLIENT_EMAIL'),
    privateKey: normalizePrivateKey(required('GOOGLE_PRIVATE_KEY')),
  },
};

// Lista ordenada de frecuencias soportadas. Se usa en varios módulos.
env.frequencies = [250, 500, 1000, 2000, 3000, 5000];

module.exports = env;
