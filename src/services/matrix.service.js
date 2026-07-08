'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const AppError = require('../errors/app-error');
const { normalizeText, normalizeCode, isMarked, headerMatches } = require('../utils/normalize');

// Selección del proveedor según el flag MATRIX_SOURCE.
const PROVIDERS = {
  local: () => require('./local-excel.service'),
  googlesheet: () => require('./google-sheets.service'),
  onedrive: () => require('./onedrive.service'),
};

const provider = PROVIDERS[env.matrixSource]();

// Alias aceptados para cada columna importante (lectura flexible).
const COLUMN_ALIASES = {
  description: ['descripcion', 'descripción', 'producto', 'descripcion producto', 'descripcion del producto'],
  partNumber: ['# parte', '#parte', 'numero de parte', 'numero parte', 'no parte', 'n parte', 'part number'],
};

/**
 * Busca la hoja cuyo nombre coincide (normalizado) con el hs_sku.
 * Devuelve { sheetName, values } o null si ninguna coincide.
 */
async function findSheetBySku(sku) {
  const target = normalizeCode(sku);
  if (!target) return null;

  const sheetNames = await provider.getSheetNames();
  const match = sheetNames.find((name) => normalizeCode(name) === target);
  if (!match) return null;

  logger.info(`hs_sku "${sku}" coincide con la hoja "${match}".`);
  const values = await provider.getSheetValues(match);
  return { sheetName: match, values };
}

/**
 * Localiza la fila de subencabezados de frecuencia: la primera fila que contenga
 * al menos dos de los tokens de frecuencia (100, 250, 500, 1000, 2000, 8000).
 * Devuelve { freqRowIndex, frequencies } (frequencies mapea freq -> índice de columna).
 */
function locateFrequencyHeader(values) {
  const freqKeys = env.frequencies.map((f) => normalizeCode(String(f)));

  for (let r = 0; r < values.length; r += 1) {
    const row = values[r] || [];
    const frequencies = {};

    row.forEach((cell, c) => {
      const key = normalizeCode(cell);
      const idx = freqKeys.indexOf(key);
      if (idx !== -1 && frequencies[env.frequencies[idx]] === undefined) {
        frequencies[env.frequencies[idx]] = c;
      }
    });

    if (Object.keys(frequencies).length >= 2) {
      return { freqRowIndex: r, frequencies };
    }
  }
  return null;
}

/**
 * Localiza las columnas de descripción y # parte buscando en la fila de
 * frecuencias y en la fila inmediatamente superior (encabezado de 2 filas).
 */
function locateTextColumns(values, freqRowIndex) {
  const columns = { description: -1, partNumber: -1 };
  const rowsToScan = [values[freqRowIndex - 1] || [], values[freqRowIndex] || []];

  for (const row of rowsToScan) {
    row.forEach((cell, c) => {
      if (columns.description === -1 && headerMatches(cell, COLUMN_ALIASES.description)) {
        columns.description = c;
      }
      if (columns.partNumber === -1 && headerMatches(cell, COLUMN_ALIASES.partNumber)) {
        columns.partNumber = c;
      }
    });
  }
  return columns;
}

/**
 * ¿La fila marca el inicio de la sección de notas (se debe cortar la lectura)?
 */
function isNoteRow(row) {
  return (row || []).some((cell) => normalizeText(cell).startsWith('nota'));
}

/**
 * Convierte la matriz de una hoja en filas de mantenimiento normalizadas.
 * Cada fila válida: { description, partNumber, frequencies: { 100: bool, ... } }.
 * Las filas sin # Parte se ignoran; la lectura se corta al llegar a "NOTA".
 */
function parseMaintenanceRows(values) {
  const freqHeader = locateFrequencyHeader(values);
  if (!freqHeader) {
    throw AppError.unprocessable(
      'No se pudo identificar la fila de frecuencias (100/250/500/1000/2000/8000) en la hoja.',
      'SHEET_HEADER_NOT_FOUND'
    );
  }

  const { freqRowIndex, frequencies: freqColumns } = freqHeader;
  const textColumns = locateTextColumns(values, freqRowIndex);

  if (textColumns.partNumber === -1) {
    throw AppError.unprocessable(
      'No se pudo identificar la columna de # Parte en la hoja.',
      'PART_NUMBER_COLUMN_NOT_FOUND'
    );
  }

  const rows = [];
  let started = false;
  for (let r = freqRowIndex + 1; r < values.length; r += 1) {
    const row = values[r] || [];
    if (isNoteRow(row)) break; // fin de la tabla de mantenimiento

    const partNumber = (row[textColumns.partNumber] || '').toString().trim();
    if (!partNumber) {
      // La tabla de productos termina en la primera fila vacía (sin # Parte)
      // que aparece después de que empezó. Todo lo que hay debajo (leyendas,
      // equivalencias, notas) queda fuera y no se ingresa como line item.
      if (started) break;
      continue; // filas vacías antes de la primera fila de datos: se saltan
    }
    started = true;

    const description =
      textColumns.description !== -1 ? (row[textColumns.description] || '').toString().trim() : '';

    const frequencies = {};
    for (const freq of env.frequencies) {
      const colIndex = freqColumns[freq];
      frequencies[freq] = colIndex !== undefined ? isMarked(row[colIndex]) : false;
    }

    rows.push({ description, partNumber, frequencies });
  }

  return rows;
}

module.exports = {
  findSheetBySku,
  parseMaintenanceRows,
  // exportadas para pruebas / reutilización
  locateFrequencyHeader,
  locateTextColumns,
};
