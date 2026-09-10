import { describe, it, expect } from 'vitest';
import { hederaIdToEvmAddress } from './hedera-id.js';

describe('hederaIdToEvmAddress', () => {
  it('convierte el factory público de ATS en testnet a su dirección long-zero', () => {
    // Verificado en vivo: eth_getCode devuelve el mismo bytecode en esta dirección long-zero
    // y en el alias real que reporta el mirror node (0xd1f118a40f3b02883d35909ef2517e7edd78379d)
    // para el contrato 0.0.9213391 — ambas rutas llegan al mismo contrato via el relay.
    expect(hederaIdToEvmAddress('0.0.9213391')).toBe('0x00000000000000000000000000000000008c95cf');
  });

  it('convierte el resolver público de ATS en testnet a su dirección long-zero', () => {
    expect(hederaIdToEvmAddress('0.0.9212226')).toBe('0x00000000000000000000000000000000008c9142');
  });

  it('produce siempre una dirección de 20 bytes (42 caracteres con el prefijo 0x)', () => {
    expect(hederaIdToEvmAddress('0.0.98')).toHaveLength(42);
  });

  it('rellena con ceros a la izquierda un número de cuenta pequeño', () => {
    expect(hederaIdToEvmAddress('0.0.98')).toBe('0x0000000000000000000000000000000000000062');
  });

  it('codifica shard y realm cuando no son cero', () => {
    expect(hederaIdToEvmAddress('1.2.3')).toBe('0x0000000100000000000000020000000000000003');
  });

  it('lanza si el id no tiene tres partes', () => {
    expect(() => hederaIdToEvmAddress('0.0')).toThrow();
    expect(() => hederaIdToEvmAddress('0.0.1.2')).toThrow();
  });

  it('lanza si alguna parte no es un entero no negativo', () => {
    expect(() => hederaIdToEvmAddress('abc.0.1')).toThrow();
    expect(() => hederaIdToEvmAddress('0.0.-1')).toThrow();
    expect(() => hederaIdToEvmAddress('0.0.1.5')).toThrow();
  });
});
