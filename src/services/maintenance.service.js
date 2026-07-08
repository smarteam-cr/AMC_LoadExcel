'use strict';

const hubspot = require('./hubspot.service');
const matrix = require('./matrix.service');
const env = require('../config/env');
const logger = require('../utils/logger');
const AppError = require('../errors/app-error');
const { normalizeCode } = require('../utils/normalize');

/**
 * Orquesta el flujo completo:
 *  1. Lee el deal original (owner + asociaciones).
 *  2. Obtiene los hs_sku de los productos de sus line items.
 *  3. Encuentra la hoja de la matriz cuyo nombre coincide con un hs_sku.
 *  4. Crea un nuevo deal replicando el original.
 *  5. Crea los line items de mantenimiento en el nuevo deal.
 */
async function generateLineItems(dealId) {
  logger.info(`Iniciando generación de mantenimiento para deal ${dealId}.`);

  // 1) Deal original.
  const deal = await hubspot.getDealWithAssociations(dealId);
  if (deal.lineItemIds.length === 0) {
    throw AppError.unprocessable(
      'El deal no tiene line items asociados para determinar el modelo de máquina.',
      'NO_LINE_ITEMS'
    );
  }

  // 2) SKUs de los productos de los line items.
  const skus = await hubspot.getLineItemsProductSkus(deal.lineItemIds);
  if (skus.length === 0) {
    throw AppError.unprocessable(
      'No fue posible obtener el hs_sku de los productos del deal.',
      'SKU_NOT_FOUND'
    );
  }

  // 3) Primera hoja de la matriz que coincida con algún hs_sku.
  let sheet = null;
  let sourceSku = null;
  for (const sku of skus) {
    const found = await matrix.findSheetBySku(sku);
    if (found) {
      sheet = found;
      sourceSku = sku;
      break;
    }
  }
  if (!sheet) {
    throw AppError.notFound(
      `No existe una hoja de mantenimiento que coincida con los SKU del deal (${skus.join(', ')}).`,
      'MATRIX_NOT_FOUND'
    );
  }

  // 4) Filas de productos de la hoja.
  const rows = matrix.parseMaintenanceRows(sheet.values);
  logger.info(`Filas válidas en la hoja "${sheet.sheetName}": ${rows.length}`);

  // 5) Nuevo deal replicado.
  const newDealName = `${deal.name || `Deal ${dealId}`}${env.hubspot.newDealNameSuffix}`;
  const newDeal = await hubspot.createDeal({
    name: newDealName,
    ownerId: deal.ownerId,
    companyIds: deal.companyIds,
    contactIds: deal.contactIds,
  });

  const summary = {
    success: true,
    dealId,
    sourceSku,
    sheetName: sheet.sheetName,
    newDealId: newDeal.id,
    processedRows: rows.length,
    lineItemsInserted: false,
    createdLineItems: 0,
    productsNotFound: [],
    errors: [],
  };

  // 6) Resolver TODOS los productos por SKU antes de insertar nada.
  // Cacheamos la búsqueda por SKU para no repetir llamadas a HubSpot cuando
  // un mismo SKU aparece en varias filas.
  const productCache = new Map();
  const resolved = []; // { product, row } listos para crear el line item.
  for (const row of rows) {
    const key = normalizeCode(row.partNumber);
    if (!productCache.has(key)) {
      productCache.set(key, await hubspot.findProductBySku(row.partNumber));
    }
    const product = productCache.get(key);
    if (!product) {
      summary.productsNotFound.push({
        partNumber: row.partNumber,
        description: row.description,
      });
      continue;
    }
    resolved.push({ product, row });
  }

  // Regla "todo o nada": si falta algún producto en HubSpot, no se inserta
  // ningún line item; el vendedor los cargará manualmente en el nuevo deal.
  if (summary.productsNotFound.length > 0) {
    summary.message =
      `No se insertó ningún line item porque ${summary.productsNotFound.length} ` +
      'producto(s) no existen en HubSpot. Cárguelos manualmente en el nuevo deal.';
    logger.warn(
      `Deal ${dealId}: ${summary.productsNotFound.length} productos no encontrados. ` +
        'No se insertan line items (todo o nada).'
    );
    return summary;
  }

  // 7) Inserción en bloque (todo o nada). Ante cualquier fallo parcial el
  // servicio revierte lo creado, de modo que el deal nunca queda a medias.
  try {
    const created = await hubspot.createMaintenanceLineItemsBatch({
      dealId: newDeal.id,
      items: resolved,
    });
    summary.lineItemsInserted = true;
    summary.createdLineItems = created.length;
  } catch (error) {
    summary.success = false;
    summary.message =
      'El deal se creó pero no se insertó ningún line item por un error en HubSpot; ' +
      'cárguelos manualmente en el nuevo deal.';
    summary.errors.push({ message: error.message, code: error.code });
    logger.error(`Deal ${dealId}: falló la inserción en bloque de line items.`, error.message);
  }

  logger.info(
    `Proceso finalizado para deal ${dealId}. Nuevo deal ${newDeal.id}. ` +
      `Creados: ${summary.createdLineItems}, no encontrados: ${summary.productsNotFound.length}, ` +
      `errores: ${summary.errors.length}.`
  );

  return summary;
}

module.exports = { generateLineItems };
