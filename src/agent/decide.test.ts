import { describe, it, expect } from 'vitest';
import { decide } from './decide.js';

const base = { priceMicroUsdc: 100, remainingMicroUsdc: 1_000, knownAgeMs: 600_000, maxStaleMs: 300_000 };

describe('regla de decisión', () => {
  it('paga cuando cabe en el presupuesto y lo que sabe está viejo', () => {
    expect(decide(base)).toEqual({ pay: true });
  });

  it('no paga si el precio no cabe en lo que le queda', () => {
    expect(decide({ ...base, remainingMicroUsdc: 50 }))
      .toEqual({ pay: false, reason: 'too_expensive' });
  });

  it('no paga si lo que ya sabe sigue fresco', () => {
    expect(decide({ ...base, knownAgeMs: 10_000 }))
      .toEqual({ pay: false, reason: 'still_fresh' });
  });

  it('el precio manda sobre la frescura cuando fallan los dos', () => {
    expect(decide({ ...base, remainingMicroUsdc: 50, knownAgeMs: 10_000 }))
      .toEqual({ pay: false, reason: 'too_expensive' });
  });

  it('un precio exactamente igual a lo que queda sí se paga', () => {
    expect(decide({ ...base, remainingMicroUsdc: 100 })).toEqual({ pay: true });
  });

  it('un dato con la edad exacta del umbral ya cuenta como viejo y se paga', () => {
    expect(decide({ ...base, knownAgeMs: base.maxStaleMs })).toEqual({ pay: true });
  });
});
