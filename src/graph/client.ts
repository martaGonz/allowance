export type GraphClient = {
  subgraphUrl: string;
  tokenApiUrl: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
};

export type PositionState = { positionId: string; liquidity: string; token0: string; token1: string };
export type TokenPrice = { contract: string; priceUsd: number; asOf: number };

const POSITION_QUERY = `
  query Position($id: ID!) {
    position(id: $id) {
      id
      liquidity
      token0 { id }
      token1 { id }
    }
  }
`;

export async function fetchPositionState(client: GraphClient, positionId: string): Promise<PositionState> {
  const res = await client.fetch(client.subgraphUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${client.apiKey}` },
    body: JSON.stringify({ query: POSITION_QUERY, variables: { id: positionId } }),
  });
  if (!res.ok) throw new Error(`Subgraph ${res.status}`);
  const body = await res.json() as { data?: { position?: { id: string; liquidity: string; token0: { id: string }; token1: { id: string } } | null } };
  const position = body.data?.position;
  if (!position) throw new Error(`posición ${positionId} no encontrada`);
  return {
    positionId: position.id,
    liquidity: position.liquidity,
    token0: position.token0.id,
    token1: position.token1.id,
  };
}

export async function fetchTokenPrice(client: GraphClient, contract: string): Promise<TokenPrice> {
  const url = `${client.tokenApiUrl}/tokens?network=base&address=${contract}`;
  const res = await client.fetch(url, {
    headers: { authorization: `Bearer ${client.apiKey}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Token API ${res.status}`);
  const body = await res.json() as { data?: Array<{ address: string; price_usd: number; datetime: string }> };
  const row = body.data?.[0];
  if (!row) throw new Error(`sin precio para ${contract}`);
  const asOf = Date.parse(row.datetime + 'Z');
  if (Number.isNaN(asOf)) throw new Error(`fecha inválida para ${contract}`);
  return { contract: row.address, priceUsd: row.price_usd, asOf };
}
