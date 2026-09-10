import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  stringToHex,
  zeroAddress,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hederaIdToEvmAddress } from './hedera-id.js';
import type { Note } from '../accounting/note.js';

// Despliegue público de ATS en Hedera
// testnet (hashgraph/asset-tokenization-studio, apps/ats/web/.env.example). No son secretos —
// son ids de un contrato ya desplegado por el equipo de ATS — así que se leen a nivel de
// módulo con su valor por defecto verificado, igual que ARC_CHAIN_ID en arc/treasury.ts.
const ATS_FACTORY_ID = process.env.ATS_FACTORY_ID ?? '0.0.9213391';
const ATS_RESOLVER_ID = process.env.ATS_RESOLVER_ID ?? '0.0.9212226';
const HEDERA_RPC_RELAY = process.env.HEDERA_RPC_RELAY ?? 'https://testnet.hashio.io/api';

// Verificado en vivo (eth_getCode idéntico en la dirección long-zero y en el alias real que
// reporta el mirror node) — ver hedera-id.ts.
const FACTORY_ADDRESS = hederaIdToEvmAddress(ATS_FACTORY_ID);
const RESOLVER_ADDRESS = hederaIdToEvmAddress(ATS_RESOLVER_ID);

export const HEDERA_TESTNET_CHAIN_ID = 296;

export const hederaTestnetChain = defineChain({
  id: HEDERA_TESTNET_CHAIN_ID,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: [HEDERA_RPC_RELAY] } },
  blockExplorers: { default: { name: 'HashScan', url: 'https://hashscan.io/testnet' } },
  testnet: true,
});

// Valores verificados del despliegue público de ATS en testnet.
export const BOND_CONFIG_ID: Hex = '0x0000000000000000000000000000000000000000000000000000000000000002';
export const DEFAULT_PARTITION: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001';

export const DEFAULT_ADMIN_ROLE: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';
export const ISSUER_ROLE: Hex = '0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f';
export const CONTROLLER_ROLE: Hex = '0xb4d2b850c3ed8a234d390d5c157bbb1824883213c335ffe2a0f0761bb168713e';
export const AGENT_ROLE: Hex = '0x9830aa071a741c08855dd42130bdb0ff50f7bdf5a4b72f12181eefded0c6542b';
// Confirmados contra la fuente: contracts/constants/roles.sol l.23 (DEFAULT_ADMIN_ROLE),
// l.78 (ROLE_ISSUER), l.47 (ROLE_CONTROLLER), l.29 (ROLE_AGENT) del paquete
// @hashgraph/asset-tokenization-contracts@8.0.0 — coinciden con estos valores.

/**
 * Versión de la configuración BOND_CONFIG_ID que se pasa a `deployBond`.
 *
 * Quedaba por aclarar "qué significa version: 0 en
 * resolverProxyConfiguration". La respuesta, leyendo la fuente, es que NO significa "última
 * versión": `DiamondCutManagerWrapper.sol` (_checkExplicitVersion, l.802-804) revierte con
 * `VersionZero` en cuanto `_version == 0`, y `ResolverProxyUnstructured._initialize` llama a
 * `checkResolverProxyConfigurationRegistered` con ese mismo valor antes de aceptar el
 * despliegue — así que `deployBond` con version:0 revierte siempre.
 * `IDiamondCutManager.sol` (comentario junto a `resolveResolverProxyCall`, l.20) lo confirma:
 * "callers that want the most recent version must read it first via
 * {getLatestVersionByConfiguration}". Se verificó en vivo contra el resolver real de testnet
 * (0.0.9212226, vía https://testnet.hashio.io/api):
 * `getLatestVersionByConfiguration(BOND_CONFIG_ID)` devuelve `1`. Se fija aquí en vez de
 * consultarla en cada emisión para que `buildBondData` siga siendo pura.
 */
export const BOND_CONFIGURATION_VERSION = 1n;

// ISIN con checksum válido (ISO 6166 / isinValidator.sol): "USALLOW0001" + dígito de control,
// calculado con el mismo algoritmo que `_checkChecksum`/`_calculateChecksum` en
// contracts/factory/isinValidator.sol (l.30-69 del paquete @hashgraph/asset-tokenization-contracts@8.0.0).
// isinValidator.sol SÍ exige checksum: _validateISIN (l.17-20) llama incondicionalmente a _checkLength (12
// caracteres — _ISIN_LENGTH, contracts/constants/values.sol l.59) y a _checkChecksum.
// Algoritmo reproducido y verificado contra un ISIN real (Apple Inc., US0378331005) antes de
// fijar la constante de abajo.
const ALLOWANCE_ISIN = 'USALLOW00010';

const NOMINAL_VALUE_DECIMALS = 6;
const NOMINAL_VALUE = 1_000_000n; // 1.000000 USD por unidad nominal, en la misma escala que decimals.

// ABI mínima pero real, transcrita de los artifacts compilados del paquete (no reescrita a
// mano desde la interfaz): FactoryFacet.json (deployBond + BondDeployed), MintFacet.json
// (issue) y ControllerByPartitionFacet.json (controllerRedeemByPartition), todas en
// node_modules/@hashgraph/asset-tokenization-contracts@8.0.0/artifacts/contracts/**.
// Exportada (no solo interna) para que el test pueda construir con encodeEventLog un log
// BondDeployed realista sin duplicar esta ABI.
export const FACTORY_ABI = [
  {
    inputs: [
      {
        components: [
          {
            components: [
              { internalType: 'contract IBusinessLogicResolver', name: 'resolver', type: 'address' },
              { internalType: 'uint256', name: 'maxSupply', type: 'uint256' },
              {
                components: [
                  { internalType: 'bytes32', name: 'key', type: 'bytes32' },
                  { internalType: 'uint256', name: 'version', type: 'uint256' },
                ],
                internalType: 'struct IFactory.ResolverProxyConfiguration',
                name: 'resolverProxyConfiguration',
                type: 'tuple',
              },
              {
                components: [
                  { internalType: 'string', name: 'name', type: 'string' },
                  { internalType: 'string', name: 'symbol', type: 'string' },
                  { internalType: 'string', name: 'isin', type: 'string' },
                  { internalType: 'uint8', name: 'decimals', type: 'uint8' },
                ],
                internalType: 'struct ICore.ERC20MetadataInfo',
                name: 'erc20MetadataInfo',
                type: 'tuple',
              },
              {
                components: [
                  { internalType: 'bytes32', name: 'role', type: 'bytes32' },
                  { internalType: 'address[]', name: 'members', type: 'address[]' },
                ],
                internalType: 'struct IResolverProxy.Rbac[]',
                name: 'rbacs',
                type: 'tuple[]',
              },
              { internalType: 'address[]', name: 'externalPauses', type: 'address[]' },
              { internalType: 'address[]', name: 'externalControlLists', type: 'address[]' },
              { internalType: 'address[]', name: 'externalKycLists', type: 'address[]' },
              { internalType: 'address', name: 'compliance', type: 'address' },
              { internalType: 'address', name: 'identityRegistry', type: 'address' },
              { internalType: 'bool', name: 'arePartitionsProtected', type: 'bool' },
              { internalType: 'bool', name: 'isMultiPartition', type: 'bool' },
              { internalType: 'bool', name: 'isControllable', type: 'bool' },
              { internalType: 'bool', name: 'isWhiteList', type: 'bool' },
              { internalType: 'bool', name: 'clearingActive', type: 'bool' },
              { internalType: 'bool', name: 'internalKycActivated', type: 'bool' },
              { internalType: 'bool', name: 'erc20VotesActivated', type: 'bool' },
            ],
            internalType: 'struct IFactory.SecurityData',
            name: 'security',
            type: 'tuple',
          },
          {
            components: [
              { internalType: 'bytes3', name: 'currency', type: 'bytes3' },
              { internalType: 'uint256', name: 'nominalValue', type: 'uint256' },
              { internalType: 'uint8', name: 'nominalValueDecimals', type: 'uint8' },
              { internalType: 'uint256', name: 'startingDate', type: 'uint256' },
              { internalType: 'uint256', name: 'maturityDate', type: 'uint256' },
            ],
            internalType: 'struct IFactory.BondDetailsData',
            name: 'bondDetails',
            type: 'tuple',
          },
          { internalType: 'address[]', name: 'proceedRecipients', type: 'address[]' },
          { internalType: 'bytes[]', name: 'proceedRecipientsData', type: 'bytes[]' },
        ],
        internalType: 'struct IFactory.BondData',
        name: '_bondData',
        type: 'tuple',
      },
      {
        components: [
          { internalType: 'enum RegulationType', name: 'regulationType', type: 'uint8' },
          { internalType: 'enum RegulationSubType', name: 'regulationSubType', type: 'uint8' },
          {
            components: [
              { internalType: 'bool', name: 'countriesControlListType', type: 'bool' },
              { internalType: 'string', name: 'listOfCountries', type: 'string' },
              { internalType: 'string', name: 'info', type: 'string' },
            ],
            internalType: 'struct AdditionalSecurityData',
            name: 'additionalSecurityData',
            type: 'tuple',
          },
        ],
        internalType: 'struct FactoryRegulationData',
        name: '_factoryRegulationData',
        type: 'tuple',
      },
    ],
    name: 'deployBond',
    outputs: [{ internalType: 'address', name: 'bondAddress_', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'deployer', type: 'address' },
      { indexed: false, internalType: 'address', name: 'bondAddress', type: 'address' },
      {
        components: [
          {
            components: [
              { internalType: 'contract IBusinessLogicResolver', name: 'resolver', type: 'address' },
              { internalType: 'uint256', name: 'maxSupply', type: 'uint256' },
              {
                components: [
                  { internalType: 'bytes32', name: 'key', type: 'bytes32' },
                  { internalType: 'uint256', name: 'version', type: 'uint256' },
                ],
                internalType: 'struct IFactory.ResolverProxyConfiguration',
                name: 'resolverProxyConfiguration',
                type: 'tuple',
              },
              {
                components: [
                  { internalType: 'string', name: 'name', type: 'string' },
                  { internalType: 'string', name: 'symbol', type: 'string' },
                  { internalType: 'string', name: 'isin', type: 'string' },
                  { internalType: 'uint8', name: 'decimals', type: 'uint8' },
                ],
                internalType: 'struct ICore.ERC20MetadataInfo',
                name: 'erc20MetadataInfo',
                type: 'tuple',
              },
              {
                components: [
                  { internalType: 'bytes32', name: 'role', type: 'bytes32' },
                  { internalType: 'address[]', name: 'members', type: 'address[]' },
                ],
                internalType: 'struct IResolverProxy.Rbac[]',
                name: 'rbacs',
                type: 'tuple[]',
              },
              { internalType: 'address[]', name: 'externalPauses', type: 'address[]' },
              { internalType: 'address[]', name: 'externalControlLists', type: 'address[]' },
              { internalType: 'address[]', name: 'externalKycLists', type: 'address[]' },
              { internalType: 'address', name: 'compliance', type: 'address' },
              { internalType: 'address', name: 'identityRegistry', type: 'address' },
              { internalType: 'bool', name: 'arePartitionsProtected', type: 'bool' },
              { internalType: 'bool', name: 'isMultiPartition', type: 'bool' },
              { internalType: 'bool', name: 'isControllable', type: 'bool' },
              { internalType: 'bool', name: 'isWhiteList', type: 'bool' },
              { internalType: 'bool', name: 'clearingActive', type: 'bool' },
              { internalType: 'bool', name: 'internalKycActivated', type: 'bool' },
              { internalType: 'bool', name: 'erc20VotesActivated', type: 'bool' },
            ],
            internalType: 'struct IFactory.SecurityData',
            name: 'security',
            type: 'tuple',
          },
          {
            components: [
              { internalType: 'bytes3', name: 'currency', type: 'bytes3' },
              { internalType: 'uint256', name: 'nominalValue', type: 'uint256' },
              { internalType: 'uint8', name: 'nominalValueDecimals', type: 'uint8' },
              { internalType: 'uint256', name: 'startingDate', type: 'uint256' },
              { internalType: 'uint256', name: 'maturityDate', type: 'uint256' },
            ],
            internalType: 'struct IFactory.BondDetailsData',
            name: 'bondDetails',
            type: 'tuple',
          },
          { internalType: 'address[]', name: 'proceedRecipients', type: 'address[]' },
          { internalType: 'bytes[]', name: 'proceedRecipientsData', type: 'bytes[]' },
        ],
        indexed: false,
        internalType: 'struct IFactory.BondData',
        name: 'bondData',
        type: 'tuple',
      },
      {
        components: [
          { internalType: 'enum RegulationType', name: 'regulationType', type: 'uint8' },
          { internalType: 'enum RegulationSubType', name: 'regulationSubType', type: 'uint8' },
          {
            components: [
              { internalType: 'bool', name: 'countriesControlListType', type: 'bool' },
              { internalType: 'string', name: 'listOfCountries', type: 'string' },
              { internalType: 'string', name: 'info', type: 'string' },
            ],
            internalType: 'struct AdditionalSecurityData',
            name: 'additionalSecurityData',
            type: 'tuple',
          },
        ],
        indexed: false,
        internalType: 'struct FactoryRegulationData',
        name: 'regulationData',
        type: 'tuple',
      },
    ],
    name: 'BondDeployed',
    type: 'event',
  },
] as const;

// De la faceta IAsset: issue (MintFacet.json) y controllerRedeemByPartition
// (ControllerByPartitionFacet.json). Se llaman sobre la dirección del bono ya desplegado —
// el proxy Diamond enruta por selector, así que no hace falta la ABI completa de la faceta.
export const ASSET_ABI = [
  {
    inputs: [
      { internalType: 'address', name: '_tokenHolder', type: 'address' },
      { internalType: 'uint256', name: '_value', type: 'uint256' },
      { internalType: 'bytes', name: '_data', type: 'bytes' },
    ],
    name: 'issue',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes32', name: '_partition', type: 'bytes32' },
      { internalType: 'address', name: '_tokenHolder', type: 'address' },
      { internalType: 'uint256', name: '_value', type: 'uint256' },
      { internalType: 'bytes', name: '_data', type: 'bytes' },
      { internalType: 'bytes', name: '_operatorData', type: 'bytes' },
    ],
    name: 'controllerRedeemByPartition',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export type BondData = ReturnType<typeof buildBondData>['bondData'];
export type RegulationData = ReturnType<typeof buildBondData>['regulationData'];

/**
 * Construye los argumentos de `deployBond` para tokenizar la nota de la paga como un bono de
 * Asset Tokenization Studio. Pura: no lee variables de entorno ni hace
 * red — el resolver, el factory, los roles y la versión de configuración son constantes del
 * despliegue público de ATS en testnet, fijadas más arriba en este módulo.
 *
 * Diseño del ciclo de vida: "emitir + asignar" concede a `input.issuer` los
 * cuatro roles (DEFAULT_ADMIN_ROLE, ISSUER_ROLE, CONTROLLER_ROLE, AGENT_ROLE) — `issuer` es
 * quien firma `deployBond` y, más tarde, `controllerRedeemByPartition` para revocar; no es el
 * agente que recibe los tokens con `issue()` (ese es un parámetro aparte en
 * `issueNoteOnChain`).
 */
export function buildBondData(input: { amountMicroUsdc: number; expiresAt: number; issuer: Hex; now: number }) {
  if (!Number.isInteger(input.amountMicroUsdc) || input.amountMicroUsdc <= 0) {
    throw new RangeError(`importe inválido: ${input.amountMicroUsdc}`);
  }
  const startingDate = BigInt(Math.floor(input.now / 1000));
  const maturityDate = BigInt(Math.floor(input.expiresAt / 1000));
  if (maturityDate <= startingDate) {
    throw new RangeError(
      `maturityDate (${maturityDate}) debe ser posterior a startingDate (${startingDate}): ` +
        'requireValidTimestamp (ScheduledTasksStorageWrapper.sol) exige que la fecha de ' +
        'vencimiento sea estrictamente futura respecto al momento en que se ejecuta la transacción',
    );
  }

  const rbacs = [DEFAULT_ADMIN_ROLE, ISSUER_ROLE, CONTROLLER_ROLE, AGENT_ROLE].map((role) => ({
    role,
    members: [input.issuer],
  }));

  const bondData = {
    security: {
      resolver: RESOLVER_ADDRESS,
      maxSupply: BigInt(input.amountMicroUsdc),
      resolverProxyConfiguration: { key: BOND_CONFIG_ID, version: BOND_CONFIGURATION_VERSION },
      erc20MetadataInfo: { name: 'Allowance Note', symbol: 'ALLOW', isin: ALLOWANCE_ISIN, decimals: 6 },
      rbacs,
      externalPauses: [] as Hex[],
      externalControlLists: [] as Hex[],
      externalKycLists: [] as Hex[],
      compliance: zeroAddress,
      identityRegistry: zeroAddress,
      arePartitionsProtected: false,
      isMultiPartition: false,
      // onlyControllable (ControllerByPartition.sol) lo exige para poder revocar con
      // controllerRedeemByPartition.
      isControllable: true,
      isWhiteList: false,
      clearingActive: false,
      internalKycActivated: false,
      erc20VotesActivated: false,
    },
    bondDetails: {
      currency: stringToHex('USD', { size: 3 }),
      nominalValue: NOMINAL_VALUE,
      nominalValueDecimals: NOMINAL_VALUE_DECIMALS,
      startingDate,
      maturityDate,
    },
    proceedRecipients: [] as Hex[],
    proceedRecipientsData: [] as Hex[],
  };

  const regulationData = {
    // REG_S sin sub-tipo: la única combinación válida sin exigir un RegulationSubType
    // (contracts/constants/regulation.sol, _isValidTypeAndSubTypeForRegS).
    regulationType: 1,
    regulationSubType: 0,
    additionalSecurityData: { countriesControlListType: false, listOfCountries: '', info: '' },
  };

  return { bondData, regulationData };
}

export type AtsWriteContractCall = {
  address: Hex;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
};

export type AtsLog = { address: Hex; topics: readonly Hex[]; data: Hex };

/**
 * Los clientes viem inyectados. Interfaz mínima — no `Pick<PublicClient, …>`/`Pick<WalletClient, …>` de viem
 * directamente, porque sus tipos genéricos complican construir un cliente falso en los tests
 * (igual que `SettleDeps` en arc/treasury.ts acota el cliente de Circle a lo que de verdad
 * usa). `liveAtsDeps()` adapta el cliente real de viem a esta forma.
 */
export type AtsDeps = {
  publicClient: {
    waitForTransactionReceipt(args: { hash: Hex }): Promise<{ logs: readonly AtsLog[] }>;
  };
  walletClient: {
    account: { address: Hex };
    writeContract(call: AtsWriteContractCall): Promise<Hex>;
  };
};

function extractBondAddress(logs: readonly AtsLog[]): Hex {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: FACTORY_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === 'BondDeployed') {
        return decoded.args.bondAddress;
      }
    } catch {
      // Log de otro evento (o de otro contrato) en el mismo recibo: se ignora y se sigue.
      continue;
    }
  }
  throw new Error('no se encontró el evento BondDeployed en el recibo del despliegue del bono');
}

/**
 * Emite la nota como un bono de ATS y la asigna al agente.
 * `deployBond` lo firma `deps.walletClient.account` (la cuenta emisora, con
 * `ATS_ISSUER_PRIVATE_KEY`); `agent` es solo el destinatario de `issue()`, la dirección EVM
 * del agente que paga las consultas (`HEDERA_EVM_ADDRESS`).
 */
export async function issueNoteOnChain(
  deps: AtsDeps,
  note: Note,
  agent: Hex,
): Promise<{ bondAddress: Hex; deployTx: Hex; issueTx: Hex }> {
  const issuer = deps.walletClient.account.address;
  const { bondData, regulationData } = buildBondData({
    amountMicroUsdc: note.amountMicroUsdc,
    expiresAt: note.expiresAt,
    issuer,
    now: Date.now(),
  });

  const deployTx = await deps.walletClient.writeContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'deployBond',
    args: [bondData, regulationData],
  });

  const receipt = await deps.publicClient.waitForTransactionReceipt({ hash: deployTx });
  const bondAddress = extractBondAddress(receipt.logs);

  const issueTx = await deps.walletClient.writeContract({
    address: bondAddress,
    abi: ASSET_ABI,
    functionName: 'issue',
    args: [agent, BigInt(note.amountMicroUsdc), '0x'],
  });

  return { bondAddress, deployTx, issueTx };
}

/**
 * Quema (revoca) la nota: `controllerRedeemByPartition` sobre la partición por defecto,
 * firmado por la cuenta emisora (ROLE_CONTROLLER u ROLE_AGENT, exigido por
 * `onlyAnyRole` en ControllerByPartition.sol). `amountMicroUsdc` es el saldo restante de la
 * nota en microUSDC: coincide con las unidades atómicas del token porque
 * `decimals` es 6.
 */
export async function burnNoteOnChain(
  deps: AtsDeps,
  bondAddress: Hex,
  agent: Hex,
  amountMicroUsdc: number,
): Promise<Hex> {
  if (!Number.isInteger(amountMicroUsdc) || amountMicroUsdc <= 0) {
    throw new RangeError(`importe inválido: ${amountMicroUsdc}`);
  }
  return deps.walletClient.writeContract({
    address: bondAddress,
    abi: ASSET_ABI,
    functionName: 'controllerRedeemByPartition',
    args: [DEFAULT_PARTITION, agent, BigInt(amountMicroUsdc), '0x', '0x'],
  });
}

function normalizePrivateKey(raw: string): Hex {
  return (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
}

/**
 * Construye los clientes viem reales para Hedera testnet (chain id 296) sobre el relay
 * JSON-RPC configurado. Lee `ATS_ISSUER_PRIVATE_KEY` DENTRO de la función — nunca al cargar
 * el módulo — igual que `liveSettleDeps` en arc/treasury.ts.
 */
export function liveAtsDeps(): AtsDeps {
  const privateKey = process.env.ATS_ISSUER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('ATS_ISSUER_PRIVATE_KEY no configurada: no se puede operar ATS de verdad');
  }
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const transport = http(HEDERA_RPC_RELAY);
  const walletClient = createWalletClient({ account, chain: hederaTestnetChain, transport });
  const publicClient = createPublicClient({ chain: hederaTestnetChain, transport });

  return {
    publicClient: {
      waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
    },
    walletClient: {
      account: { address: account.address },
      writeContract: (call) =>
        walletClient.writeContract({
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          account,
          chain: hederaTestnetChain,
        } as Parameters<typeof walletClient.writeContract>[0]),
    },
  };
}
