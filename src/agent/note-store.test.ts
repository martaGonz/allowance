import { describe, it, expect } from 'vitest';
import { createNoteStore } from './note-store.js';
import { createNote, burn } from '../accounting/note.js';

describe('almacén de la nota', () => {
  it('devuelve lo último que se le puso, no lo inicial', () => {
    const note = createNote({ amountMicroUsdc: 1_000, expiresAt: Date.now() + 3_600_000 });
    const store = createNoteStore(note);
    expect(store.get()).toBe(note);

    const burned = burn(note);
    store.set(burned);
    expect(store.get()).toBe(burned);
    expect(store.get().burned).toBe(true);
  });
});
