'use strict';

const hubspot = require('./hubspot.service');
const sheets = require('./google-sheets.service');
const logger = require('../utils/logger');
const AppError = require('../errors/app-error');
const { normalizeCode } = require('../utils/normalize');

/**
 * Orquesta todo el flujo de generación de line items de mantenimiento.
 * Recibe el dealId ya validado y devuelve el resumen del proceso.
 */
async function generateLineItems(dealId) {
  logger.info(`Iniciando generación de mantenimiento para deal ${dealId}.`);

  // 1) Line items actuales del deal.
  const lineItems = await hubspot.getDealLineItems(dealId);
  if (lineItems.length === 0) {
    throw AppError.unprocessable(
      'El deal no tiene line items asociados para obtener el código de máquina.',
      'NO_LINE_ITEMS'
    );
  }

  // 2) Código de máquina.
  const machineCode = hubspot.getMachineCodeFromLineItems(lineItems);
  if (!machineCode) {
    throw AppError.unprocessable(
      'No fue posible determinar el código de máquina a partir de los line items.',
      'MACHINE_CODE_NOT_FOUND'
    );
  }
  logger.info(`Código de máquina detectado: ${machineCode}`);

  // 3) Hoja de Google Sheets que coincide con el código.
  const match = await sheets.findSheetByMachineCode(machineCode);
  if (!match) {
    throw AppError.notFound(
      `No existe matriz de mantenimiento para la máquina ${machineCode}.`,
      'MATRIX_NOT_FOUND'
    );
  }

  // 4) Filas de productos válidas.
  const rows = sheets.parseMaintenanceRows(match.values);
  logger.info(`Filas válidas en la hoja "${match.sheetName}": ${rows.length}`);

  // 5) Índice de duplicados ya existentes (creados por este proceso).
  const existing = await hubspot.getExistingMaintenanceLineItems(dealId, lineItems);

  const summary = {
    success: true,
    dealId,
    codigoMaquina: machineCode,
    sheetName: match.sheetName,
    processedRows: rows.length,
    createdLineItems: 0,
    skippedDuplicates: 0,
    productsNotFound: [],
    errors: [],
  };

  const machineKey = normalizeCode(machineCode);

  // 6) Procesar cada fila de forma independiente (un fallo no detiene el resto).
  for (const row of rows) {
    const duplicateKey = `${machineKey}::${normalizeCode(row.partNumber)}`;

    if (existing.has(duplicateKey)) {
      summary.skippedDuplicates += 1;
      logger.debug(`Duplicado omitido para parte ${row.partNumber}.`);
      continue;
    }

    try {
      const product = await hubspot.findProductByPartNumber(row.partNumber);
      if (!product) {
        summary.productsNotFound.push({
          partNumber: row.partNumber,
          description: row.description,
        });
        continue;
      }

      await hubspot.createMaintenanceLineItem({
        dealId,
        product,
        row,
        frequencies: row.frequencies,
        machineCode,
      });

      existing.add(duplicateKey); // evita duplicados dentro de la misma corrida
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
    `Proceso finalizado para deal ${dealId}. Creados: ${summary.createdLineItems}, ` +
      `duplicados: ${summary.skippedDuplicates}, no encontrados: ${summary.productsNotFound.length}, ` +
      `errores: ${summary.errors.length}.`
  );

  return summary;
}

module.exports = { generateLineItems };
