import { describe, it, expect } from 'vitest';
import { fetchPositionState, fetchTokenPrice } from './client.js';

function fakeFetch(payload: unknown, status = 200) {
  return async () => new Response(JSON.stringify(payload), { status });
}

const client = (f: typeof globalThis.fetch) => ({
  subgraphUrl: 'https://gateway.thegraph.com/api/subgraphs/id/FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS',
  apiKey: 'k',
  fetch: f,
});

describe('cliente de The Graph (Standardized Subgraph de Messari, uniswap-v3-base)', () => {
  it('lee el estado de la posición desde el Subgraph, con liquidityUsd y closed', async () => {
    const f = fakeFetch({
      data: {
        position: {
          id: '0xabc123',
          liquidity: '123',
          liquidityUSD: '456.78',
          timestampClosed: null,
          pool: { inputTokens: [{ id: '0xa' }, { id: '0xb' }] },
        },
      },
    });
    const state = await fetchPositionState(client(f as any), '0xABC123');
    expect(state).toEqual({
      positionId: '0xabc123',
      liquidity: '123',
      liquidityUsd: '456.78',
      token0: '0xa',
      token1: '0xb',
      closed: false,
    });
  });

  it('marca closed=true cuando timestampClosed no es null', async () => {
    const f = fakeFetch({
      data: {
        position: {
          id: '0xabc123',
          liquidity: '0',
          liquidityUSD: '0',
          timestampClosed: '1700000000',
          pool: { inputTokens: [{ id: '0xa' }, { id: '0xb' }] },
        },
      },
    });
    const state = await fetchPositionState(client(f as any), '0xabc123');
    expect(state.closed).toBe(true);
  });

  it('lee el precio desde el Subgraph, con asOf calculado desde _meta.block.timestamp', async () => {
    const f = fakeFetch({
      data: {
        token: { id: '0xa', lastPriceUSD: '2500.5' },
        _meta: { block: { timestamp: 1757505600 } },
      },
    });
    const price = await fetchTokenPrice(client(f as any), '0xA');
    expect(price).toEqual({ contract: '0xa', priceUsd: 2500.5, asOf: 1757505600000 });
  });

  it('normaliza positionId y contract a minúsculas antes de consultar, y en la respuesta', async () => {
    let sentBody = '';
    const f = (async (_url: unknown, init: any) => {
      sentBody = init.body;
      return new Response(
        JSON.stringify({
          data: { token: { id: '0xabc', lastPriceUSD: '1' }, _meta: { block: { timestamp: 1 } } },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const price = await fetchTokenPrice(client(f), '0xABC');
    expect(price.contract).toBe('0xabc');
    expect(JSON.parse(sentBody).variables.id).toBe('0xabc');
  });

  it('lanza si el Subgraph no devuelve la posición, para que nunca se cobre por un dato vacío', async () => {
    const f = fakeFetch({ data: { position: null } });
    await expect(fetchPositionState(client(f as any), '0xABC123')).rejects.toThrow('posición 0xabc123 no encontrada');
  });

  it('lanza si la posición tiene menos de dos tokens de entrada en el pool', async () => {
    const f = fakeFetch({
      data: {
        position: {
          id: '0xabc123',
          liquidity: '1',
          liquidityUSD: '1',
          timestampClosed: null,
          pool: { inputTokens: [{ id: '0xa' }] },
        },
      },
    });
    await expect(fetchPositionState(client(f as any), '0xabc123')).rejects.toThrow();
  });

  it('lanza con el mensaje de errors[] de GraphQL aunque el HTTP sea 200, y no con "no encontrada"', async () => {
    const f = fakeFetch({ errors: [{ message: 'subgraph deployment not found' }] });
    await expect(fetchPositionState(client(f as any), '0xabc123')).rejects.toThrow('subgraph deployment not found');
  });

  it('lanza si lastPriceUSD es null, para no dar por real un precio inexistente', async () => {
    const f = fakeFetch({
      data: { token: { id: '0xa', lastPriceUSD: null }, _meta: { block: { timestamp: 1757505600 } } },
    });
    await expect(fetchTokenPrice(client(f as any), '0xa')).rejects.toThrow();
  });

  it('lanza si el token no existe en el Subgraph', async () => {
    const f = fakeFetch({ data: { token: null, _meta: { block: { timestamp: 1757505600 } } } });
    await expect(fetchTokenPrice(client(f as any), '0xa')).rejects.toThrow();
  });

  it('lanza si el timestamp de _meta no es numérico, para no dar por fresco un dato sin fecha', async () => {
    const f = fakeFetch({
      data: { token: { id: '0xa', lastPriceUSD: '1' }, _meta: { block: { timestamp: 'no-es-un-numero' } } },
    });
    await expect(fetchTokenPrice(client(f as any), '0xa')).rejects.toThrow('fecha inválida para 0xa');
  });

  it('lanza si el Subgraph responde con HTTP no-ok', async () => {
    const f = fakeFetch({ message: 'nope' }, 500);
    await expect(fetchTokenPrice(client(f as any), '0xa')).rejects.toThrow('Subgraph 500');
  });

  it('lanza si el HTTP no-ok llega también a fetchPositionState', async () => {
    const f = fakeFetch({ message: 'nope' }, 500);
    await expect(fetchPositionState(client(f as any), '0xabc123')).rejects.toThrow('Subgraph 500');
  });
});
