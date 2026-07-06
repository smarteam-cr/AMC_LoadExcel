'use strict';

/**
 * Normaliza un texto para comparaciones tolerantes:
 * - lo convierte a string
 * - quita acentos
 * - colapsa espacios
 * - pasa a minúsculas y recorta extremos
 */
function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // elimina diacríticos
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Normaliza un código de máquina o número de parte para comparar.
 * Elimina todos los espacios internos además de acentos y mayúsculas.
 */
function normalizeCode(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

/**
 * Determina si una celda de frecuencia está marcada con "X".
 * Tolera variantes como "x", " X ", "✓", "si", "sí".
 */
function isMarked(cellValue) {
  const normalized = normalizeText(cellValue);
  if (!normalized) return false;
  return ['x', '✓', 'si', 'yes', 'true', '1'].includes(normalized);
}

/**
 * Compara dos cabeceras de columna de forma flexible.
 * Por ejemplo "# PARTE", "#Parte", "numero de parte" -> coincide con los alias dados.
 */
function headerMatches(header, aliases) {
  const normalizedHeader = normalizeCode(header);
  return aliases.some((alias) => normalizedHeader === normalizeCode(alias));
}

module.exports = {
  normalizeText,
  normalizeCode,
  isMarked,
  headerMatches,
};
