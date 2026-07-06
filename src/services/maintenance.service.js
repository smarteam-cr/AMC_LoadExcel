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
    createdLineItems: 0,
    productsNotFound: [],
    errors: [],
  };

  // 6) Crear line items en el nuevo deal (un fallo no detiene el resto).
  // Cada fila genera su propio line item: un mismo SKU puede aparecer en
  // varias filas con frecuencias distintas. Cacheamos la búsqueda del
  // producto por SKU para no repetir llamadas a HubSpot.
  const productCache = new Map();
  for (const row of rows) {
    try {
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

      await hubspot.createMaintenanceLineItem({ dealId: newDeal.id, product, row });
      summary.createdLineItems += 1;
    } catch (error) {
      logger.error(`Error procesando la parte ${row.partNumber}:`, error.message);
      summary.errors.push({
        partNumber: row.partNumber,
        description: row.description,
        message: error.message,
      });
    }
  }

  logger.info(
    `Proceso finalizado para deal ${dealId}. Nuevo deal ${newDeal.id}. ` +
      `Creados: ${summary.createdLineItems}, no encontrados: ${summary.productsNotFound.length}, ` +
      `errores: ${summary.errors.length}.`
  );

  return summary;
}

module.exports = { generateLineItems };
