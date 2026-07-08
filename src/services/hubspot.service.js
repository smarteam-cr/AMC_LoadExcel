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
  const associations = deal.associations || {};
  // HubSpot v3 devuelve la clave de asociación con nombre "legible": p. ej.
  // los line items llegan bajo "line items" (con espacio), no "line_items".
  // Normalizamos las claves (espacios/guiones bajos) para tolerar ambas variantes.
  const target = name.replace(/[\s_]+/g, '');
  const key = Object.keys(associations).find(
    (k) => k.replace(/[\s_]+/g, '') === target
  );
  if (!key) return [];
  return (associations[key]?.results || []).map((r) => r.id).filter(Boolean);
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
 * Construye las propiedades de un line item de mantenimiento a partir del
 * producto y la fila de la matriz.
 * - Hereda el producto vía hs_product_id (HubSpot completa precio/nombre).
 * - Envía cada frecuencia como booleano: true si tiene X, false si no.
 * - `position` fija el orden de visualización (hs_position_on_quote) para que
 *   los line items queden como en el Excel.
 */
function buildLineItemProperties({ product, row, position }) {
  const h = env.hubspot;

  const properties = {
    hs_product_id: product.id,
    quantity: '1',
    name: product.properties?.name || row.description || `Parte ${row.partNumber}`,
  };

  if (Number.isInteger(position)) {
    properties.hs_position_on_quote = String(position);
  }

  for (const freq of env.frequencies) {
    const propName = h.frequencyProperties[freq];
    if (propName) {
      properties[propName] = row.frequencies[freq] ? h.frequencyValueYes : h.frequencyValueNo;
    }
  }

  return properties;
}

/**
 * Construye la asociación line item -> deal para los payloads de creación.
 */
function lineItemToDealAssociation(dealId) {
  const h = env.hubspot;
  return {
    to: { id: String(dealId) },
    types: [
      {
        associationCategory: 'HUBSPOT_DEFINED',
        associationTypeId: h.lineItemToDealAssociationTypeId,
      },
    ],
  };
}

/**
 * Archiva (elimina) line items por lote. Se usa como rollback cuando una
 * creación en bloque queda parcialmente completa.
 */
async function deleteLineItems(ids) {
  const list = (ids || []).map(String).filter(Boolean);
  if (list.length === 0) return;
  try {
    await client.post('/crm/v3/objects/line_items/batch/archive', {
      inputs: list.map((id) => ({ id })),
    });
  } catch (error) {
    // El rollback es best-effort: registramos pero no enmascaramos el error real.
    logger.error('No se pudo hacer rollback de line items:', JSON.stringify(list), error.message);
  }
}

/**
 * Crea en bloque todos los line items de mantenimiento asociados al deal.
 * Semántica "todo o nada": si HubSpot reporta cualquier fallo parcial, se
 * archivan los que sí se crearon y se lanza un error. No se dejan line items
 * a medias en el deal.
 *
 * @param {{ dealId: string|number, items: Array<{product: object, row: object}> }} args
 * @returns {Promise<Array>} line items creados.
 */
async function createMaintenanceLineItemsBatch({ dealId, items }) {
  if (!items || items.length === 0) return [];

  // El índice preserva el orden del Excel vía hs_position_on_quote.
  const inputs = items.map(({ product, row }, index) => ({
    properties: buildLineItemProperties({ product, row, position: index }),
    associations: [lineItemToDealAssociation(dealId)],
  }));

  let resp;
  try {
    resp = await client.post('/crm/v3/objects/line_items/batch/create', { inputs });
  } catch (error) {
    // Fallo total (4xx/5xx): HubSpot no creó nada, no hay nada que revertir.
    throw toUpstreamError(error, 'createMaintenanceLineItemsBatch');
  }

  const created = resp.data?.results || [];

  // 207 MULTI_STATUS o cuerpo con errores => éxito parcial. Rollback + error.
  const partial =
    resp.status === 207 ||
    (resp.data?.numErrors && resp.data.numErrors > 0) ||
    (Array.isArray(resp.data?.errors) && resp.data.errors.length > 0) ||
    created.length !== items.length;

  if (partial) {
    await deleteLineItems(created.map((li) => li.id));
    logger.error(
      `Creación parcial de line items (${created.length}/${items.length}). ` +
        `Se revirtieron los creados. Respuesta: ${JSON.stringify(resp.data)}`
    );
    throw AppError.upstream(
      'HubSpot no pudo crear todos los line items; no se insertó ninguno.',
      'LINE_ITEMS_PARTIAL_FAILURE',
      { created: created.length, expected: items.length, body: resp.data }
    );
  }

  return created;
}

module.exports = {
  getDealWithAssociations,
  getLineItemsProductSkus,
  findProductBySku,
  getFirstPipelineStage,
  createDeal,
  createMaintenanceLineItemsBatch,
  deleteLineItems,
};
