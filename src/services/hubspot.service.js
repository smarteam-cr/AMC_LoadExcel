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

let pipelineFirstStageCache = {};

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

function associationIds(deal, name) {
  return (deal.associations?.[name]?.results || []).map((r) => r.id).filter(Boolean);
}

/**
 * Lee el deal original con su owner y las asociaciones necesarias para
 * replicarlo (companies, contacts, line_items).
 */
async function getDealWithAssociations(dealId) {
  try {
    const resp = await client.get(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      params: {
        properties: 'dealname,hubspot_owner_id',
        associations: 'companies,contacts,line_items',
      },
    });
    const deal = resp.data;
    return {
      id: deal.id,
      name: deal.properties?.dealname || '',
      ownerId: deal.properties?.hubspot_owner_id || '',
      companyIds: associationIds(deal, 'companies'),
      contactIds: associationIds(deal, 'contacts'),
      lineItemIds: associationIds(deal, 'line_items'),
    };
  } catch (error) {
    if (error.response?.status === 404) {
      throw AppError.notFound(`El deal ${dealId} no existe o no es accesible.`, 'DEAL_NOT_FOUND');
    }
    throw toUpstreamError(error, 'getDealWithAssociations');
  }
}

/**
 * A partir de los IDs de line items obtiene los hs_sku de sus productos.
 * Devuelve una lista de SKUs (en el orden de los line items, sin vacíos).
 */
async function getLineItemsProductSkus(lineItemIds) {
  if (!lineItemIds || lineItemIds.length === 0) return [];

  try {
    // 1) Line items -> hs_product_id.
    const liResp = await client.post('/crm/v3/objects/line_items/batch/read', {
      properties: ['hs_product_id'],
      inputs: lineItemIds.map((id) => ({ id: String(id) })),
    });

    const productIds = (liResp.data.results || [])
      .map((li) => li.properties?.hs_product_id)
      .filter(Boolean);

    if (productIds.length === 0) return [];

    // 2) Productos -> hs_sku.
    const prodResp = await client.post('/crm/v3/objects/products/batch/read', {
      properties: ['hs_sku'],
      inputs: productIds.map((id) => ({ id: String(id) })),
    });

    return (prodResp.data.results || [])
      .map((p) => (p.properties?.hs_sku || '').toString().trim())
      .filter((sku) => sku !== '');
  } catch (error) {
    throw toUpstreamError(error, 'getLineItemsProductSkus');
  }
}

/**
 * Busca un producto en HubSpot por su SKU (número de parte).
 * Devuelve el primer producto que coincida o null si no existe.
 */
async function findProductBySku(sku) {
  const prop = env.hubspot.productSkuProperty;
  try {
    const resp = await client.post('/crm/v3/objects/products/search', {
      filterGroups: [{ filters: [{ propertyName: prop, operator: 'EQ', value: sku }] }],
      properties: ['name', 'price', 'hs_sku', prop],
      limit: 5,
    });

    const results = resp.data.results || [];
    if (results.length === 0) return null;

    // Coincidencia exacta tras normalizar, por si HubSpot devuelve aproximados.
    const target = normalizeCode(sku);
    const exact = results.find((p) => normalizeCode(p.properties?.[prop]) === target);
    return exact || results[0];
  } catch (error) {
    throw toUpstreamError(error, 'findProductBySku');
  }
}

/**
 * Devuelve el ID de la primera etapa (por displayOrder) de un pipeline de deals.
 */
async function getFirstPipelineStage(pipelineId) {
  if (pipelineFirstStageCache[pipelineId]) return pipelineFirstStageCache[pipelineId];
  try {
    const resp = await client.get(`/crm/v3/pipelines/deals/${encodeURIComponent(pipelineId)}`);
    const stages = resp.data.stages || [];
    if (stages.length === 0) {
      throw AppError.unprocessable(
        `El pipeline ${pipelineId} no tiene etapas configuradas.`,
        'PIPELINE_WITHOUT_STAGES'
      );
    }
    const sorted = [...stages].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
    pipelineFirstStageCache[pipelineId] = sorted[0].id;
    return sorted[0].id;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw toUpstreamError(error, 'getFirstPipelineStage');
  }
}

/**
 * Crea un nuevo deal replicando owner y asociaciones (companies, contacts)
 * del original, en el pipeline por defecto configurado.
 */
async function createDeal({ name, ownerId, companyIds = [], contactIds = [] }) {
  const h = env.hubspot;
  const pipeline = h.defaultDealPipeline;
  const dealstage = h.defaultDealStage || (await getFirstPipelineStage(pipeline));

  const properties = { dealname: name, pipeline, dealstage };
  if (ownerId) properties.hubspot_owner_id = ownerId;

  const associations = [];
  for (const companyId of companyIds) {
    associations.push({
      to: { id: String(companyId) },
      types: [
        {
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId: h.dealToCompanyAssociationTypeId,
        },
      ],
    });
  }
  for (const contactId of contactIds) {
    associations.push({
      to: { id: String(contactId) },
      types: [
        {
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId: h.dealToContactAssociationTypeId,
        },
      ],
    });
  }

  try {
    const resp = await client.post('/crm/v3/objects/deals', { properties, associations });
    logger.info(`Nuevo deal creado: ${resp.data.id} ("${name}").`);
    return resp.data;
  } catch (error) {
    throw toUpstreamError(error, 'createDeal');
  }
}

/**
 * Crea un line item de mantenimiento asociado al deal indicado.
 * - Hereda el producto vía hs_product_id (HubSpot completa precio/nombre).
 * - Marca como "Si" únicamente las frecuencias con X (las demás no se envían).
 */
async function createMaintenanceLineItem({ dealId, product, row }) {
  const h = env.hubspot;

  const properties = {
    hs_product_id: product.id,
    quantity: '1',
    name: product.properties?.name || row.description || `Parte ${row.partNumber}`,
  };

  // Solo se envían las frecuencias marcadas con X.
  for (const freq of env.frequencies) {
    if (!row.frequencies[freq]) continue;
    const propName = h.frequencyProperties[freq];
    if (propName) properties[propName] = h.frequencyValueYes;
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
  getDealWithAssociations,
  getLineItemsProductSkus,
  findProductBySku,
  getFirstPipelineStage,
  createDeal,
  createMaintenanceLineItem,
};
