import { describe, it, expect } from 'vitest';
import { createNote, debit, burn, remaining } from './note.js';

const T0 = 1_757_000_000_000;
const HOUR = 3_600_000;

describe('paga', () => {
  it('la suma de débitos nunca supera lo emitido', () => {
    let note = createNote({ amountMicroUsdc: 1_000, expiresAt: T0 + HOUR });
    const first = debit(note, 600, T0);
    expect(first.ok).toBe(true);
    note = first.note;
    const second = debit(note, 600, T0);
    expect(second).toMatchObject({ ok: false, reason: 'exhausted' });
    expect(remaining(second.note)).toBe(400);
  });

  it('una nota quemada rechaza todo débito posterior', () => {
    const note = burn(createNote({ amountMicroUsdc: 1_000, expiresAt: T0 + HOUR }));
    expect(debit(note, 1, T0)).toMatchObject({ ok: false, reason: 'burned' });
  });

  it('una nota vencida rechaza todo débito posterior', () => {
    const note = createNote({ amountMicroUsdc: 1_000, expiresAt: T0 });
    expect(debit(note, 1, T0 + 1)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('un débito exacto hasta cero es válido y deja la nota a cero', () => {
    const note = createNote({ amountMicroUsdc: 500, expiresAt: T0 + HOUR });
    const result = debit(note, 500, T0);
    expect(result.ok).toBe(true);
    expect(remaining(result.note)).toBe(0);
  });

  it('un débito rechazado no muta la nota original', () => {
    const note = createNote({ amountMicroUsdc: 100, expiresAt: T0 + HOUR });
    debit(note, 999, T0);
    expect(remaining(note)).toBe(100);
  });

  it('un débito negativo se rechaza y no aumenta el saldo', () => {
    const note = createNote({ amountMicroUsdc: 1_000, expiresAt: T0 + HOUR });
    expect(() => debit(note, -500, T0)).toThrow(RangeError);
    expect(remaining(note)).toBe(1_000);
  });

  it('un débito con decimales se rechaza', () => {
    const note = createNote({ amountMicroUsdc: 1_000, expiresAt: T0 + HOUR });
    expect(() => debit(note, 0.5, T0)).toThrow(RangeError);
  });

  it('un débito de cero se rechaza', () => {
    const note = createNote({ amountMicroUsdc: 1_000, expiresAt: T0 + HOUR });
    expect(() => debit(note, 0, T0)).toThrow(RangeError);
  });

  it('no se puede emitir una nota con importe no positivo o con decimales', () => {
    expect(() => createNote({ amountMicroUsdc: -100, expiresAt: T0 + HOUR })).toThrow(RangeError);
    expect(() => createNote({ amountMicroUsdc: 0, expiresAt: T0 + HOUR })).toThrow(RangeError);
    expect(() => createNote({ amountMicroUsdc: 1.5, expiresAt: T0 + HOUR })).toThrow(RangeError);
  });
});
