'use strict';

const { google } = require('googleapis');
const env = require('../config/env');
const logger = require('../utils/logger');
const AppError = require('../errors/app-error');
const { normalizeText, normalizeCode, isMarked, headerMatches } = require('../utils/normalize');

// Alias aceptados para cada columna importante (lectura flexible).
const COLUMN_ALIASES = {
  description: ['descripcion', 'descripción', 'producto', 'descripcion producto', 'descripcion del producto'],
  partNumber: ['# parte', '#parte', 'numero de parte', 'numero parte', 'no parte', 'n parte', 'part number'],
};

// Etiquetas que suelen acompañar al código de máquina dentro de la hoja.
const MACHINE_CODE_LABELS = ['codigo maquina', 'código máquina', 'codigo de maquina', 'cod maquina', 'codigo'];

let sheetsClient = null;

/**
 * Crea (una sola vez) el cliente autenticado de Google Sheets.
 */
function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.JWT({
    email: env.google.clientEmail,
    key: env.google.privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function toUpstreamError(error, action) {
  const message = error.errors?.[0]?.message || error.message;
  logger.error(`Google Sheets error en ${action}:`, message);
  return AppError.upstream(`Error consultando Google Sheets (${action}).`, 'GOOGLE_SHEETS_ERROR', {
    message,
  });
}

/**
 * Devuelve los nombres de todas las hojas del spreadsheet.
 */
async function getSpreadsheetSheets() {
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.get({ spreadsheetId: env.google.sheetId });
    return (resp.data.sheets || []).map((s) => s.properties.title);
  } catch (error) {
    throw toUpstreamError(error, 'getSpreadsheetSheets');
  }
}

/**
 * Devuelve la matriz de valores (filas x columnas) de una hoja.
 */
async function getSheetValues(sheetName) {
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: env.google.sheetId,
      range: sheetName,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    return resp.data.values || [];
  } catch (error) {
    throw toUpstreamError(error, `getSheetValues(${sheetName})`);
  }
}

/**
 * Busca dentro de una matriz de valores el código de máquina.
 * Estrategia 1: celda con etiqueta "Codigo Maquina" y el valor en la celda contigua.
 * Estrategia 2: coincidencia directa del código en cualquier celda.
 */
function sheetContainsMachineCode(values, machineCode) {
  const target = normalizeCode(machineCode);
  if (!target) return false;

  for (let r = 0; r < values.length; r += 1) {
    const rowCells = values[r] || [];
    for (let c = 0; c < rowCells.length; c += 1) {
      const cell = rowCells[c];

      // Coincidencia directa del valor.
      if (normalizeCode(cell) === target) return true;

      // Etiqueta seguida del valor (misma fila a la derecha o fila inferior).
      if (MACHINE_CODE_LABELS.includes(normalizeText(cell))) {
        const right = rowCells[c + 1];
        const below = (values[r + 1] || [])[c];
        if (normalizeCode(right) === target || normalizeCode(below) === target) return true;
      }
    }
  }
  return false;
}

/**
 * Recorre todas las hojas hasta encontrar una que contenga el código de máquina.
 * Devuelve { sheetName, values } o null si ninguna coincide.
 */
async function findSheetByMachineCode(machineCode) {
  const sheetNames = await getSpreadsheetSheets();
  for (const sheetName of sheetNames) {
    const values = await getSheetValues(sheetName);
    if (sheetContainsMachineCode(values, machineCode)) {
      logger.info(`Código de máquina "${machineCode}" encontrado en la hoja "${sheetName}".`);
      return { sheetName, values };
    }
  }
  return null;
}

/**
 * Localiza la fila de encabezados: la primera fila que contenga a la vez
 * la columna de # Parte y al menos una columna de frecuencia.
 * Devuelve { headerRowIndex, columns } donde columns mapea nombres -> índice.
 */
function locateHeader(values) {
  for (let r = 0; r < values.length; r += 1) {
    const row = values[r] || [];
    const columns = { description: -1, partNumber: -1, frequencies: {} };

    row.forEach((cell, c) => {
      if (headerMatches(cell, COLUMN_ALIASES.description) && columns.description === -1) {
        columns.description = c;
      }
      if (headerMatches(cell, COLUMN_ALIASES.partNumber) && columns.partNumber === -1) {
        columns.partNumber = c;
      }
      for (const freq of env.frequencies) {
        if (normalizeCode(cell) === normalizeCode(String(freq))) {
          columns.frequencies[freq] = c;
        }
      }
    });

    const hasPart = columns.partNumber !== -1;
    const hasAnyFrequency = Object.keys(columns.frequencies).length > 0;
    if (hasPart && hasAnyFrequency) {
      return { headerRowIndex: r, columns };
    }
  }
  return null;
}

/**
 * Convierte la matriz de una hoja en filas de mantenimiento normalizadas.
 * Cada fila válida: { description, partNumber, frequencies: { 250: bool, ... } }.
 * Las filas sin # Parte se ignoran.
 */
function parseMaintenanceRows(values) {
  const header = locateHeader(values);
  if (!header) {
    throw AppError.unprocessable(
      'No se pudo identificar la fila de encabezados (# Parte y frecuencias) en la hoja.',
      'SHEET_HEADER_NOT_FOUND'
    );
  }

  const { headerRowIndex, columns } = header;
  const rows = [];

  for (let r = headerRowIndex + 1; r < values.length; r += 1) {
    const row = values[r] || [];
    const partNumber = (row[columns.partNumber] || '').toString().trim();
    if (!partNumber) continue; // regla: sin # Parte se ignora

    const description =
      columns.description !== -1 ? (row[columns.description] || '').toString().trim() : '';

    const frequencies = {};
    for (const freq of env.frequencies) {
      const colIndex = columns.frequencies[freq];
      frequencies[freq] = colIndex !== undefined ? isMarked(row[colIndex]) : false;
    }

    rows.push({ description, partNumber, frequencies });
  }

  return rows;
}

module.exports = {
  getSpreadsheetSheets,
  getSheetValues,
  findSheetByMachineCode,
  parseMaintenanceRows,
  // exportadas para pruebas / reutilización
  sheetContainsMachineCode,
  locateHeader,
};
