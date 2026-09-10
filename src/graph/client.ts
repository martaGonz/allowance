export type GraphClient = {
  subgraphUrl: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
};

export type PositionState = {
  positionId: string;
  liquidity: string;
  liquidityUsd: string;
  token0: string;
  token1: string;
  closed: boolean;
};
export type TokenPrice = { contract: string; priceUsd: number; asOf: number };

// Standardized Subgraph de Messari para Uniswap v3 en Base (esquema DEX AMM
// Extended, messari/subgraphs subgraphs/uniswap-v3-forks/schema.graphql):
// da a la vez el estado de la posición y el precio USD de los tokens desde
// una única URL de Subgraph, sin depender de la Token API.
const POSITION_QUERY = `
  query Position($id: ID!) {
    position(id: $id) {
      id
      liquidity
      liquidityUSD
      timestampClosed
      pool {
        inputTokens { id }
      }
    }
  }
`;

const TOKEN_QUERY = `
  query Token($id: ID!) {
    token(id: $id) {
      id
      lastPriceUSD
    }
    _meta {
      block {
        timestamp
      }
    }
  }
`;

type GraphQlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

async function queryGraph<T>(client: GraphClient, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await client.fetch(client.subgraphUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${client.apiKey}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Subgraph ${res.status}`);
  const body = (await res.json()) as GraphQlResponse<T>;
  if (body.errors && body.errors.length > 0) throw new Error(body.errors[0]!.message);
  if (body.data === undefined) throw new Error('Subgraph sin datos');
  return body.data;
}

type PositionData = {
  position: {
    id: string;
    liquidity: string;
    liquidityUSD: string;
    timestampClosed: string | null;
    pool: { inputTokens: Array<{ id: string }> };
  } | null;
};

export async function fetchPositionState(client: GraphClient, positionId: string): Promise<PositionState> {
  const id = positionId.toLowerCase();
  const data = await queryGraph<PositionData>(client, POSITION_QUERY, { id });
  const position = data.position;
  if (!position) throw new Error(`posición ${id} no encontrada`);
  const tokens = position.pool.inputTokens;
  if (tokens.length < 2) throw new Error(`posición ${id} sin dos tokens de entrada en el pool`);
  return {
    positionId: id,
    liquidity: position.liquidity,
    liquidityUsd: position.liquidityUSD,
    token0: tokens[0]!.id,
    token1: tokens[1]!.id,
    closed: position.timestampClosed !== null,
  };
}

type TokenData = {
  token: { id: string; lastPriceUSD: string | null } | null;
  _meta: { block: { timestamp: number | string } };
};

export async function fetchTokenPrice(client: GraphClient, contract: string): Promise<TokenPrice> {
  const id = contract.toLowerCase();
  const data = await queryGraph<TokenData>(client, TOKEN_QUERY, { id });
  const token = data.token;
  if (!token) throw new Error(`token ${id} no encontrado`);
  if (token.lastPriceUSD === null) throw new Error(`sin precio para ${id}`);
  const priceUsd = Number(token.lastPriceUSD);
  if (Number.isNaN(priceUsd)) throw new Error(`precio inválido para ${id}`);
  const asOf = Number(data._meta.block.timestamp) * 1000;
  if (Number.isNaN(asOf)) throw new Error(`fecha inválida para ${id}`);
  return { contract: id, priceUsd, asOf };
}
