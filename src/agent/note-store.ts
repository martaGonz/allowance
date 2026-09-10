import type { Note } from '../accounting/note.js';

/**
 * Almacén compartido de la nota de gasto. El bucle del agente y el botón "Revocar" del
 * panel comparten la misma instancia: el agente lee la nota al principio de
 * cada intento de débito y el panel la reemplaza con `burn(store.get())`, así
 * que el siguiente intento de débito del agente ve la nota quemada sin que
 * nadie tenga que pasarle el evento explícitamente.
 */
export type NoteStore = {
  get(): Note;
  set(note: Note): void;
};

export function createNoteStore(initial: Note): NoteStore {
  let current = initial;
  return {
    get: () => current,
    set: (note) => {
      current = note;
    },
  };
}
