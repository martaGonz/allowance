import { describe, it, expect } from 'vitest';
import { fetchPositionState, fetchTokenPrice } from './client.js';

function fakeFetch(payload: unknown, status = 200) {
  return async () => new Response(JSON.stringify(payload), { status });
}

const client = (f: typeof globalThis.fetch) => ({
  subgraphUrl: 'https://sub.example/x',
  tokenApiUrl: 'https://api.pinax.network/v1',
  apiKey: 'k',
  fetch: f,
});

describe('cliente de The Graph', () => {
  it('lee el estado de la posición desde el Subgraph', async () => {
    const f = fakeFetch({ data: { position: { id: '7', liquidity: '123', token0: { id: '0xa' }, token1: { id: '0xb' } } } });
    const state = await fetchPositionState(client(f as any), '7');
    expect(state).toEqual({ positionId: '7', liquidity: '123', token0: '0xa', token1: '0xb' });
  });

  it('lee el precio desde la Token API', async () => {
    const f = fakeFetch({ data: [{ address: '0xa', price_usd: 2500.5, datetime: '2026-09-10 10:00:00' }] });
    const price = await fetchTokenPrice(client(f as any), '0xa');
    expect(price.contract).toBe('0xa');
    expect(price.priceUsd).toBe(2500.5);
  });

  it('lanza si el Subgraph no devuelve la posición, para que nunca se cobre por un dato vacío', async () => {
    const f = fakeFetch({ data: { position: null } });
    await expect(fetchPositionState(client(f as any), '7')).rejects.toThrow('posición 7 no encontrada');
  });

  it('lanza si la Token API responde con error HTTP', async () => {
    const f = fakeFetch({ message: 'nope' }, 500);
    await expect(fetchTokenPrice(client(f as any), '0xa')).rejects.toThrow('Token API 500');
  });

  it('lanza si la fecha del precio no se puede interpretar, para no dar por fresco un dato sin fecha', async () => {
    const f = fakeFetch({ data: [{ address: '0xa', price_usd: 1, datetime: 'no-es-una-fecha' }] });
    await expect(fetchTokenPrice(client(f as any), '0xa')).rejects.toThrow('fecha inválida para 0xa');
  });
});
