/** Strikte Boolean-Normalisierung für JSON- und Formular-API-Aufrufe. */
export function parseBoolean(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}
