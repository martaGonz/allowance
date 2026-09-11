import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress, type Hex } from 'viem';
import {
  buildBondData,
  issueNoteOnChain,
  burnNoteOnChain,
  FACTORY_ABI,
  DEFAULT_PARTITION,
  BOND_CONFIG_ID,
  DEFAULT_ADMIN_ROLE,
  ISSUER_ROLE,
  CONTROLLER_ROLE,
  AGENT_ROLE,
  type AtsDeps,
  type AtsWriteContractCall,
} from './ats.js';
import { hederaIdToEvmAddress } from './hedera-id.js';
import { createNote } from '../accounting/note.js';

const ISSUER: Hex = '0x0000000000000000000000000000000000000011';
const AGENT: Hex = '0x0000000000000000000000000000000000000022';
// decodeEventLog devuelve las direcciones en formato checksum EIP-55 (viem), aunque en el
// log codificado (y en la vida real, en las direcciones long-zero de Hedera) vayan en
// minúsculas — se normaliza aquí para comparar como iguales.
const BOND_ADDRESS: Hex = getAddress('0x000000000000000000000000000000000000abcd');
const NOW = 1_800_000_000_000; // ms fijos, para que los tests sean deterministas
const EXPIRES_AT = NOW + 3_600_000;

describe('buildBondData', () => {
  const { bondData, regulationData } = buildBondData({
    amountMicroUsdc: 5_000_000,
    expiresAt: EXPIRES_AT,
    issuer: ISSUER,
    now: NOW,
  });

  it('apunta al resolver público de ATS en testnet', () => {
    expect(bondData.security.resolver).toBe('0xba2d5fc2083a0b8f164c50e65d782087fba18e0a');
  });

  it('fija maxSupply al importe de la nota en microUSDC', () => {
    expect(bondData.security.maxSupply).toBe(5_000_000n);
  });

  it('fija la configuración de bono al BOND_CONFIG_ID verificado, con versión explícita', () => {
    expect(bondData.security.resolverProxyConfiguration.key).toBe(BOND_CONFIG_ID);
    // Qué significa version:0 — no es "última versión": el propio
    // contrato lo rechaza (ver DiamondCutManagerWrapper.sol, _checkExplicitVersion). La
    // versión 1 es la que devuelve getLatestVersionByConfiguration(BOND_CONFIG_ID) contra el
    // resolver real de testnet (verificado en vivo).
    expect(bondData.security.resolverProxyConfiguration.version).toBe(1n);
  });

  it('fija nombre, símbolo, decimales e ISIN con checksum válido', () => {
    expect(bondData.security.erc20MetadataInfo).toEqual({
      name: 'Allowance Note',
      symbol: 'ALLOW',
      isin: 'USALLOW00010',
      decimals: 6,
    });
  });

  it('concede a la cuenta emisora los cuatro roles exigidos por el ciclo de vida', () => {
    expect(bondData.security.rbacs).toEqual([
      { role: DEFAULT_ADMIN_ROLE, members: [ISSUER] },
      { role: ISSUER_ROLE, members: [ISSUER] },
      { role: CONTROLLER_ROLE, members: [ISSUER] },
      { role: AGENT_ROLE, members: [ISSUER] },
    ]);
  });

  it('desactiva las listas externas, el cumplimiento y el registro de identidad', () => {
    expect(bondData.security.externalPauses).toEqual([]);
    expect(bondData.security.externalControlLists).toEqual([]);
    expect(bondData.security.externalKycLists).toEqual([]);
    expect(bondData.security.compliance).toBe(zeroAddress);
    expect(bondData.security.identityRegistry).toBe(zeroAddress);
    expect(bondData.security.internalKycActivated).toBe(false);
  });

  it('fija los flags de partición y control exigidos por issue/controllerRedeemByPartition', () => {
    // isControllable debe ser true: lo exige onlyControllable en controllerRedeemByPartition
    // (ControllerByPartition.sol). isMultiPartition debe ser false: lo exige
    // onlyWithoutMultiPartition en issue (Mint.sol).
    expect(bondData.security.isControllable).toBe(true);
    expect(bondData.security.isMultiPartition).toBe(false);
    expect(bondData.security.arePartitionsProtected).toBe(false);
    expect(bondData.security.isWhiteList).toBe(false);
    expect(bondData.security.clearingActive).toBe(false);
    expect(bondData.security.erc20VotesActivated).toBe(false);
  });

  it('fija currency USD en bytes3', () => {
    expect(bondData.bondDetails.currency).toBe('0x555344');
  });

  it('fija startingDate y maturityDate en segundos, a partir de now y expiresAt en ms', () => {
    expect(bondData.bondDetails.startingDate).toBe(BigInt(Math.floor(NOW / 1000)));
    expect(bondData.bondDetails.maturityDate).toBe(BigInt(Math.floor(EXPIRES_AT / 1000)));
  });

  it('no exige destinatarios de proceeds', () => {
    expect(bondData.proceedRecipients).toEqual([]);
    expect(bondData.proceedRecipientsData).toEqual([]);
  });

  it('regula bajo REG_S sin sub-tipo, la única combinación válida sin sub-tipo (regulation.sol)', () => {
    expect(regulationData.regulationType).toBe(1);
    expect(regulationData.regulationSubType).toBe(0);
    expect(regulationData.additionalSecurityData).toEqual({
      countriesControlListType: false,
      listOfCountries: '',
      info: '',
    });
  });

  it('lanza con un importe no entero o no positivo', () => {
    expect(() => buildBondData({ amountMicroUsdc: 0, expiresAt: EXPIRES_AT, issuer: ISSUER, now: NOW })).toThrow();
    expect(() => buildBondData({ amountMicroUsdc: 1.5, expiresAt: EXPIRES_AT, issuer: ISSUER, now: NOW })).toThrow();
  });

  it('lanza si expiresAt no es posterior a now', () => {
    expect(() => buildBondData({ amountMicroUsdc: 1_000, expiresAt: NOW, issuer: ISSUER, now: NOW })).toThrow();
  });
});

/** Cliente viem falso: registra cada llamada a writeContract y sirve un recibo prefabricado.
 * `status` por defecto es 'success' — las pruebas de recibo revertido lo sobreescriben. */
function fakeDeps(
  receiptLogs: { address: Hex; topics: Hex[]; data: Hex }[],
  status: 'success' | 'reverted' = 'success',
): {
  deps: AtsDeps;
  calls: AtsWriteContractCall[];
} {
  const calls: AtsWriteContractCall[] = [];
  let nextHash = 1;
  const deps: AtsDeps = {
    publicClient: {
      waitForTransactionReceipt: async () => ({ logs: receiptLogs, status }),
    },
    walletClient: {
      account: { address: ISSUER },
      writeContract: async (call) => {
        calls.push(call);
        const hash = `0x${'0'.repeat(63)}${nextHash}` as Hex;
        nextHash += 1;
        return hash;
      },
    },
  };
  return { deps, calls };
}

describe('issueNoteOnChain', () => {
  it('despliega el bono y emite al agente, sin red (cliente viem falso)', async () => {
    const note = createNote({ amountMicroUsdc: 5_000_000, expiresAt: EXPIRES_AT });
    const { bondData, regulationData } = buildBondData({
      amountMicroUsdc: note.amountMicroUsdc,
      expiresAt: note.expiresAt,
      issuer: ISSUER,
      now: NOW,
    });
    // viem 2.56 no expone `encodeEventLog`: se arma el log a mano con las dos mitades que sí
    // expone (`encodeEventTopics` para los indexados, `encodeAbiParameters` para el resto),
    // usando la misma ABI real que `issueNoteOnChain` decodifica — así el topic0 coincide por
    // construcción.
    // FACTORY_ABI[1] es la entrada BondDeployed (índice fijo, ver ats.ts): indexarla así, en
    // vez de buscarla con `.find`, conserva su tipo de tupla literal exacto (con `indexed` en
    // cada input) en vez de ensancharlo al tipo genérico `AbiEvent`.
    const bondDeployedEvent = FACTORY_ABI[1];
    const nonIndexedInputs = bondDeployedEvent.inputs.filter((input) => !input.indexed);
    const topics = encodeEventTopics({ abi: FACTORY_ABI, eventName: 'BondDeployed', args: { deployer: ISSUER } });
    const data = encodeAbiParameters(nonIndexedInputs, [BOND_ADDRESS, bondData, regulationData]);
    // encodeEventTopics tipa el resultado como (Hex | null)[] en general (un topic de filtro
    // omitido saldría null); aquí siempre se provee `deployer`, así que en tiempo de
    // ejecución no hay ningún null.
    const { deps, calls } = fakeDeps([{ address: BOND_ADDRESS, topics: topics as Hex[], data }]);

    const result = await issueNoteOnChain(deps, note, AGENT);

    expect(result.bondAddress).toBe(BOND_ADDRESS);
    expect(calls).toHaveLength(2);

    const deployCall = calls[0]!;
    expect(deployCall.functionName).toBe('deployBond');
    expect(deployCall.address).toBe('0xd1f118a40f3b02883d35909ef2517e7edd78379d');

    const issueCall = calls[1]!;
    expect(issueCall.functionName).toBe('issue');
    expect(issueCall.address).toBe(BOND_ADDRESS);
    expect(issueCall.args).toEqual([AGENT, BigInt(note.amountMicroUsdc), '0x']);

    expect(result.deployTx).toBeTruthy();
    expect(result.issueTx).toBeTruthy();
  });

  it('lanza si no hay evento BondDeployed en el recibo del despliegue', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: EXPIRES_AT });
    const { deps } = fakeDeps([]);

    await expect(issueNoteOnChain(deps, note, AGENT)).rejects.toThrow();
  });

  // Hallazgo importante 5 de la revisión de rama completa: antes de este arreglo,
  // `issueNoteOnChain` devolvía el hash de `issue()` sin esperar su recibo, y el recibo del
  // propio `deployBond()` se usaba solo para leer sus logs — nunca se comprobaba `status`. Una
  // transacción revertida en Hedera puede tardar en confirmarse igual que una exitosa: sin
  // este chequeo, `main.ts` publicaría `issued_onchain` (y el agente empezaría a gastar) con
  // un bono que nunca se desplegó de verdad.
  it('lanza si el recibo del despliegue revirtió (status !== success), sin llegar a llamar a issue()', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: EXPIRES_AT });
    const { bondData, regulationData } = buildBondData({
      amountMicroUsdc: note.amountMicroUsdc,
      expiresAt: note.expiresAt,
      issuer: ISSUER,
      now: NOW,
    });
    const bondDeployedEvent = FACTORY_ABI[1];
    const nonIndexedInputs = bondDeployedEvent.inputs.filter((input) => !input.indexed);
    const topics = encodeEventTopics({ abi: FACTORY_ABI, eventName: 'BondDeployed', args: { deployer: ISSUER } });
    const data = encodeAbiParameters(nonIndexedInputs, [BOND_ADDRESS, bondData, regulationData]);
    // El evento SÍ está presente en el recibo (para aislar el chequeo de status del chequeo de
    // evento cubierto por la prueba anterior) — solo `status` marca la reversión.
    const { deps, calls } = fakeDeps([{ address: BOND_ADDRESS, topics: topics as Hex[], data }], 'reverted');

    await expect(issueNoteOnChain(deps, note, AGENT)).rejects.toThrow();
    expect(calls).toHaveLength(1); // deployBond se llamó, issue() nunca — el recibo revertido corta antes
  });

  it('lanza si el recibo de issue() revirtió, aunque el despliegue haya tenido éxito', async () => {
    const note = createNote({ amountMicroUsdc: 1_000_000, expiresAt: EXPIRES_AT });
    const { bondData, regulationData } = buildBondData({
      amountMicroUsdc: note.amountMicroUsdc,
      expiresAt: note.expiresAt,
      issuer: ISSUER,
      now: NOW,
    });
    const bondDeployedEvent = FACTORY_ABI[1];
    const nonIndexedInputs = bondDeployedEvent.inputs.filter((input) => !input.indexed);
    const topics = encodeEventTopics({ abi: FACTORY_ABI, eventName: 'BondDeployed', args: { deployer: ISSUER } });
    const data = encodeAbiParameters(nonIndexedInputs, [BOND_ADDRESS, bondData, regulationData]);

    const calls: AtsWriteContractCall[] = [];
    let nextHash = 1;
    let receiptCalls = 0;
    const deps: AtsDeps = {
      publicClient: {
        waitForTransactionReceipt: async () => {
          receiptCalls += 1;
          if (receiptCalls === 1) {
            return { logs: [{ address: BOND_ADDRESS, topics: topics as Hex[], data }], status: 'success' as const };
          }
          return { logs: [], status: 'reverted' as const };
        },
      },
      walletClient: {
        account: { address: ISSUER },
        writeContract: async (call) => {
          calls.push(call);
          const hash = `0x${'0'.repeat(63)}${nextHash}` as Hex;
          nextHash += 1;
          return hash;
        },
      },
    };

    await expect(issueNoteOnChain(deps, note, AGENT)).rejects.toThrow();
    expect(calls).toHaveLength(2); // deployBond (éxito) e issue() (revertido) se llamaron ambas
  });
});

describe('burnNoteOnChain', () => {
  it('llama a controllerRedeemByPartition con la partición por defecto y el saldo restante', async () => {
    const { deps, calls } = fakeDeps([]);

    const txHash = await burnNoteOnChain(deps, BOND_ADDRESS, AGENT, 2_500_000);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.address).toBe(BOND_ADDRESS);
    expect(call.functionName).toBe('controllerRedeemByPartition');
    expect(call.args).toEqual([DEFAULT_PARTITION, AGENT, 2_500_000n, '0x', '0x']);
    expect(txHash).toBeTruthy();
  });

  it('lanza con un importe no entero o no positivo', async () => {
    const { deps } = fakeDeps([]);
    await expect(burnNoteOnChain(deps, BOND_ADDRESS, AGENT, 0)).rejects.toThrow();
    await expect(burnNoteOnChain(deps, BOND_ADDRESS, AGENT, 1.5)).rejects.toThrow();
  });

  // Hallazgo importante 5: antes de este arreglo, `burnNoteOnChain` devolvía el hash de
  // `controllerRedeemByPartition` sin esperar su recibo — una revocación que revierte en
  // cadena se publicaría igualmente como `burned_onchain` en el panel, dejando al usuario
  // creyendo que ya no puede gastar más cuando la nota sigue activa on-chain.
  it('lanza si el recibo de controllerRedeemByPartition revirtió (status !== success)', async () => {
    const { deps } = fakeDeps([], 'reverted');

    await expect(burnNoteOnChain(deps, BOND_ADDRESS, AGENT, 2_500_000)).rejects.toThrow();
  });
});
