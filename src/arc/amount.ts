/**
 * Convierte microUSDC enteros (la unidad de la contabilidad interna) al
 * decimal en texto que exige `createTransaction` de Circle (`amount:
 * string[]`). Puro y sin coma flotante: la conversión trabaja siempre sobre
 * los dígitos del entero, nunca sobre una división o multiplicación real.
 *
 * microUSDC tiene 6 decimales, así que basta con rellenar por la izquierda
 * hasta al menos 7 dígitos, partir en parte entera (todo menos los últimos
 * 6 dígitos) y parte fraccionaria (los últimos 6), y recortar los ceros de
 * cola de la fraccionaria.
 */
export function microUsdcToDecimal(amountMicroUsdc: number): string {
  if (!Number.isInteger(amountMicroUsdc) || amountMicroUsdc <= 0) {
    throw new RangeError(`importe inválido: ${amountMicroUsdc}`);
  }
  const digits = String(amountMicroUsdc).padStart(7, '0');
  const integerPart = digits.slice(0, -6);
  const fractionalPart = digits.slice(-6).replace(/0+$/, '');
  return fractionalPart === '' ? integerPart : `${integerPart}.${fractionalPart}`;
}
