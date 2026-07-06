'use strict';

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');
const { normalizeCode } = require('../utils/normalize');
const AppError = require('../errors/app-error');

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

const client = axios.create({
  baseURL: HUBSPOT_BASE_URL,
  headers: {
    Authorization: `Bearer ${env.hubspot.accessToken}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

/**
 * Convierte un error de axios en un AppError con contexto útil.
 */
function toUpstreamError(error, action) {
  const status = error.response?.status;
  const body = error.response?.data;
  logger.error(`HubSpot error en ${action}:`, status, JSON.stringify(body || error.message));
  return AppError.upstream(`Error consultando HubSpot (${action}).`, 'HUBSPOT_ERROR', {
    status,
    body,
  });
}

/**
 * Obtiene los line items asociados a un deal, con las propiedades indicadas.
 */
async function getDealLineItems(dealId) {
  try {
    // 1) IDs de line items asociados al deal.
    const assocResp = await client.get(
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/line_items`,
      { params: { limit: 500 } }
    );

    const ids = (assocResp.data.results || []).map((r) => r.toObjectId || r.id).filter(Boolean);
    if (ids.length === 0) return [];

    // 2) Lectura por lote de las propiedades relevantes.
    const properties = [
      env.hubspot.machineCodeProperty,
      env.hubspot.maintenancePartNumberProperty,
      env.hubspot.maintenanceSourceMachineCodeProperty,
      env.hubspot.maintenanceGeneratedProperty,
      'name',
      'hs_product_id',
    ];

    const batchResp = await client.post('/crm/v3/objects/line_items/batch/read', {
      properties,
      inputs: ids.map((id) => ({ id: String(id) })),
    });

    return batchResp.data.results || [];
  } catch (error) {
    if (error.response?.status === 404) {
      throw AppError.notFound(`El deal ${dealId} no existe o no es accesible.`, 'DEAL_NOT_FOUND');
    }
    throw toUpstreamError(error, 'getDealLineItems');
  }
}

/**
 * Extrae el código de máquina desde los line items del deal.
 * Devuelve el primer valor no vacío encontrado en la propiedad configurada.
 */
function getMachineCodeFromLineItems(lineItems) {
  const prop = env.hubspot.machineCodeProperty;
  for (const item of lineItems) {
    const value = item.properties?.[prop];
    if (value && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

/**
 * Busca un producto en HubSpot por su número de parte.
 * Devuelve el primer producto que coincida o null si no existe.
 */
async function findProductByPartNumber(partNumber) {
  const prop = env.hubspot.productPartNumberProperty;
  try {
    const resp = await client.post('/crm/v3/objects/products/search', {
      filterGroups: [
        {
          filters: [{ propertyName: prop, operator: 'EQ', value: partNumber }],
        },
      ],
      properties: ['name', 'price', 'hs_sku', prop],
      limit: 5,
    });

    const results = resp.data.results || [];
    if (results.length === 0) return null;

    // Coincidencia exacta tras normalizar, por si HubSpot devuelve aproximados.
    const target = normalizeCode(partNumber);
    const exact = results.find((p) => normalizeCode(p.properties?.[prop]) === target);
    return exact || results[0];
  } catch (error) {
    throw toUpstreamError(error, 'findProductByPartNumber');
  }
}

/**
 * Obtiene los line items del deal que fueron creados por este proceso,
 * indexados por una clave "machineCode::partNumber" para detectar duplicados.
 */
async function getExistingMaintenanceLineItems(dealId, lineItems) {
  const items = lineItems || (await getDealLineItems(dealId));
  const generatedProp = env.hubspot.maintenanceGeneratedProperty;
  const partProp = env.hubspot.maintenancePartNumberProperty;
  const machineProp = env.hubspot.maintenanceSourceMachineCodeProperty;

  const index = new Set();
  for (const item of items) {
    const props = item.properties || {};
    const isGenerated = String(props[generatedProp]).toLowerCase() === 'true';
    const partNumber = props[partProp];
    if (!isGenerated || !partNumber) continue;
    const machineCode = props[machineProp] || '';
    index.add(`${normalizeCode(machineCode)}::${normalizeCode(partNumber)}`);
  }
  return index;
}

/**
 * Crea un line item de mantenimiento asociado al deal.
 * - Hereda el producto vía hs_product_id (HubSpot completa precio/nombre).
 * - Marca las frecuencias según el mapa { 250: true, 500: false, ... }.
 * - Guarda metadatos para prevención de duplicados.
 */
async function createMaintenanceLineItem({ dealId, product, row, frequencies, machineCode }) {
  const h = env.hubspot;

  const properties = {
    hs_product_id: product.id,
    quantity: '1',
    name: product.properties?.name || row.description || `Parte ${row.partNumber}`,
    [h.maintenanceGeneratedProperty]: 'true',
    [h.maintenanceSourceMachineCodeProperty]: machineCode,
    [h.maintenancePartNumberProperty]: row.partNumber,
  };

  // Propiedades de frecuencia -> "Si" / "No".
  for (const freq of env.frequencies) {
    const propName = h.frequencyProperties[freq];
    if (!propName) continue;
    properties[propName] = frequencies[freq] ? h.frequencyValueYes : h.frequencyValueNo;
  }

  const payload = {
    properties,
    associations: [
      {
        to: { id: String(dealId) },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: h.lineItemToDealAssociationTypeId,
          },
        ],
      },
    ],
  };

  try {
    const resp = await client.post('/crm/v3/objects/line_items', payload);
    return resp.data;
  } catch (error) {
    throw toUpstreamError(error, 'createMaintenanceLineItem');
  }
}

module.exports = {
  getDealLineItems,
  getMachineCodeFromLineItems,
  findProductByPartNumber,
  getExistingMaintenanceLineItems,
  createMaintenanceLineItem,
};
