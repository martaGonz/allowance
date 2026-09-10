import { describe, it, expect } from 'vitest';
import { microUsdcToDecimal } from './amount.js';

describe('microUsdcToDecimal', () => {
  it('2000 microUSDC son 0.002 USDC', () => {
    expect(microUsdcToDecimal(2_000)).toBe('0.002');
  });

  it('1 microUSDC es el mínimo representable, 0.000001 USDC', () => {
    expect(microUsdcToDecimal(1)).toBe('0.000001');
  });

  it('1_500_000 microUSDC son 1.5 USDC, sin ceros de más', () => {
    expect(microUsdcToDecimal(1_500_000)).toBe('1.5');
  });

  it('1_000_000 microUSDC son 1 USDC exacto, sin punto decimal', () => {
    expect(microUsdcToDecimal(1_000_000)).toBe('1');
  });

  it('lanza RangeError si el importe no es un entero', () => {
    expect(() => microUsdcToDecimal(1.5)).toThrow(RangeError);
  });

  it('lanza RangeError si el importe es cero o negativo', () => {
    expect(() => microUsdcToDecimal(0)).toThrow(RangeError);
    expect(() => microUsdcToDecimal(-1)).toThrow(RangeError);
  });
});
