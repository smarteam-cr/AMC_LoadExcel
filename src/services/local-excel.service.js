'use strict';

const path = require('path');
const ExcelJS = require('exceljs');
const env = require('../config/env');
const AppError = require('../errors/app-error');
const logger = require('../utils/logger');

let workbookPromise = null;

/**
 * Carga el workbook una sola vez y lo cachea.
 */
function loadWorkbook() {
  if (workbookPromise) return workbookPromise;
  const filePath = path.resolve(process.cwd(), env.local.excelPath);
  const workbook = new ExcelJS.Workbook();
  workbookPromise = workbook.xlsx
    .readFile(filePath)
    .then(() => workbook)
    .catch((error) => {
      workbookPromise = null; // permite reintentar en la siguiente llamada
      logger.error(`Excel local error leyendo ${filePath}:`, error.message);
      throw AppError.upstream(
        `No se pudo leer el archivo Excel local (${filePath}).`,
        'LOCAL_EXCEL_ERROR',
        { message: error.message }
      );
    });
  return workbookPromise;
}

/**
 * Convierte el valor de una celda de exceljs a texto plano.
 */
function cellToString(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((rt) => rt.text).join('');
    if (v.text !== undefined) return String(v.text); // hyperlink
    if (v.result !== undefined) return String(v.result); // fórmula con resultado
    if (v.formula !== undefined) return ''; // fórmula sin resultado cacheado
    return String(cell.text || '');
  }
  return String(v);
}

/**
 * Devuelve los nombres de todas las hojas del workbook.
 */
async function getSheetNames() {
  const workbook = await loadWorkbook();
  return workbook.worksheets.map((ws) => ws.name);
}

/**
 * Devuelve la matriz de valores (filas x columnas) de una hoja, 0-indexada,
 * con el mismo formato que los demás proveedores.
 */
async function getSheetValues(sheetName) {
  const workbook = await loadWorkbook();
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) return [];

  const values = [];
  const columnCount = worksheet.columnCount;
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells = [];
    for (let c = 1; c <= columnCount; c += 1) {
      cells.push(cellToString(row.getCell(c)));
    }
    values[rowNumber - 1] = cells;
  });

  // Rellena posibles huecos (filas totalmente vacías) para evitar undefined.
  for (let i = 0; i < values.length; i += 1) {
    if (!values[i]) values[i] = [];
  }
  return values;
}

module.exports = { getSheetNames, getSheetValues };
