import { randomUUID } from 'node:crypto';

export type Note = {
  id: string;
  amountMicroUsdc: number;
  spentMicroUsdc: number;
  expiresAt: number;
  burned: boolean;
};

export type DebitResult =
  | { ok: true; note: Note }
  | { ok: false; reason: 'exhausted' | 'expired' | 'burned'; note: Note };

export function createNote(input: { amountMicroUsdc: number; expiresAt: number }): Note {
  if (!Number.isInteger(input.amountMicroUsdc) || input.amountMicroUsdc <= 0) {
    throw new RangeError(`importe inválido: ${input.amountMicroUsdc}`);
  }
  return {
    id: randomUUID(),
    amountMicroUsdc: input.amountMicroUsdc,
    spentMicroUsdc: 0,
    expiresAt: input.expiresAt,
    burned: false,
  };
}

export function remaining(note: Note): number {
  return note.amountMicroUsdc - note.spentMicroUsdc;
}

export function burn(note: Note): Note {
  return { ...note, burned: true };
}

export function debit(note: Note, amountMicroUsdc: number, now: number): DebitResult {
  if (!Number.isInteger(amountMicroUsdc) || amountMicroUsdc <= 0) {
    throw new RangeError(`importe inválido: ${amountMicroUsdc}`);
  }
  if (note.burned) return { ok: false, reason: 'burned', note };
  if (now > note.expiresAt) return { ok: false, reason: 'expired', note };
  if (amountMicroUsdc > remaining(note)) return { ok: false, reason: 'exhausted', note };
  return { ok: true, note: { ...note, spentMicroUsdc: note.spentMicroUsdc + amountMicroUsdc } };
}
