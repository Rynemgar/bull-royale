import crypto from 'crypto';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getMint,
  getAccount,
  getTokenMetadata,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

let connection = null;

export function getConnection() {
  if (!connection) connection = new Connection(RPC_URL, 'confirmed');
  return connection;
}

function loadEncryptionKey() {
  const raw = process.env.WALLET_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('WALLET_ENCRYPTION_KEY is not set');
  }
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    try {
      key = Buffer.from(raw, 'base64');
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== 32) {
    throw new Error('WALLET_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  }
  return key;
}

/** AES-256-GCM — returns `iv:tag:ciphertext` all base64. */
export function encryptSecret(secretBytes) {
  const key = loadEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(secretBytes)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload) {
  const key = loadEncryptionKey();
  const parts = String(payload || '').split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted secret format');
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function generateGroupWallet() {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey.toBase58(),
    secretKeyBytes: Buffer.from(kp.secretKey)
  };
}

export function keypairFromSecretBytes(secretBytes) {
  return Keypair.fromSecretKey(Uint8Array.from(secretBytes));
}

/** Base58 secret key for wallet import (Phantom, Solflare, etc.). */
export function secretKeyToBase58(secretBytes) {
  return bs58.encode(Uint8Array.from(secretBytes));
}

export function validateSolanaAddress(str) {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(String(str || '').trim());
    return true;
  } catch {
    return false;
  }
}

/** User wallets should be on-curve signers. */
export function validateWalletAddress(str) {
  try {
    const pk = new PublicKey(String(str || '').trim());
    return PublicKey.isOnCurve(pk.toBytes());
  } catch {
    return false;
  }
}

export async function getSolBalance(pubkeyStr) {
  const conn = getConnection();
  const lamports = await conn.getBalance(new PublicKey(pubkeyStr));
  return lamports / LAMPORTS_PER_SOL;
}

/** Resolve whether a mint is classic SPL or Token-2022. */
export async function resolveTokenProgramId(mintPk) {
  const conn = getConnection();
  const info = await conn.getAccountInfo(mintPk instanceof PublicKey ? mintPk : new PublicKey(mintPk));
  if (!info) throw new Error('Mint account not found');
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Account is not an SPL mint (owner ${info.owner.toBase58()})`);
}

export async function getTokenBalance(ownerPubkey, mintStr) {
  const conn = getConnection();
  const owner = new PublicKey(ownerPubkey);
  const mint = new PublicKey(mintStr);
  let programId;
  try {
    programId = await resolveTokenProgramId(mint);
  } catch {
    return { ui: 0, raw: 0n, decimals: 0 };
  }
  const ata = await getAssociatedTokenAddress(
    mint,
    owner,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  try {
    const acct = await getAccount(conn, ata, 'confirmed', programId);
    const mintInfo = await getMint(conn, mint, 'confirmed', programId);
    const raw = Number(acct.amount);
    const ui = raw / 10 ** mintInfo.decimals;
    return { ui, raw: acct.amount, decimals: mintInfo.decimals, programId: programId.toBase58() };
  } catch {
    const mintInfo = await getMint(conn, mint, 'confirmed', programId).catch(() => null);
    return { ui: 0, raw: 0n, decimals: mintInfo?.decimals ?? 0, programId: programId.toBase58() };
  }
}

/** All non-zero SPL / Token-2022 balances for an owner wallet. */
export async function getWalletTokenBalances(ownerPubkey) {
  const conn = getConnection();
  const owner = new PublicKey(ownerPubkey);
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const byMint = new Map();

  for (const programId of programs) {
    let resp;
    try {
      resp = await conn.getParsedTokenAccountsByOwner(owner, { programId });
    } catch (e) {
      console.error('getParsedTokenAccountsByOwner failed', programId.toBase58(), e?.message || e);
      continue;
    }
    for (const { account } of resp.value) {
      const info = account.data?.parsed?.info;
      if (!info?.mint) continue;
      const amount = info.tokenAmount;
      const ui = Number(amount?.uiAmount);
      if (!Number.isFinite(ui) || ui <= 0) continue;
      const mint = info.mint;
      const prev = byMint.get(mint);
      if (!prev || ui > prev.ui) {
        byMint.set(mint, {
          mint,
          ui,
          decimals: Number(amount?.decimals ?? 0),
          symbol: null,
          name: null
        });
      }
    }
  }

  const list = [...byMint.values()];
  await Promise.all(
    list.map(async (t) => {
      try {
        t.name = await getTokenMetadataName(t.mint);
      } catch {
        t.name = `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`;
      }
    })
  );
  list.sort((a, b) => b.ui - a.ui);
  return list;
}

function readBorshString(buf, offset) {
  if (offset + 4 > buf.length) return { value: null, next: offset };
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > buf.length || len > 200) return { value: null, next: offset };
  return { value: buf.slice(start, end).toString('utf8'), next: end };
}

function formatTokenLabel(name, symbol) {
  const cleanName = (name || '').replace(/\0/g, '').trim();
  const cleanSymbol = (symbol || '').replace(/\0/g, '').trim();
  if (cleanName && cleanSymbol && cleanName.toLowerCase() !== cleanSymbol.toLowerCase()) {
    return `${cleanName} (${cleanSymbol})`;
  }
  return cleanName || cleanSymbol || null;
}

function shortMint(mintStr) {
  return `${mintStr.slice(0, 4)}…${mintStr.slice(-4)}`;
}

async function nameFromMetaplex(mintStr) {
  const mint = new PublicKey(mintStr);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
  const conn = getConnection();
  const info = await conn.getAccountInfo(pda, 'confirmed');
  if (!info?.data) return null;
  const data = Buffer.from(info.data);
  // key(1) + updateAuthority(32) + mint(32)
  let offset = 1 + 32 + 32;
  const name = readBorshString(data, offset);
  if (!name.value) return null;
  offset = name.next;
  const symbol = readBorshString(data, offset);
  return formatTokenLabel(name.value, symbol.value);
}

async function nameFromToken2022(mintStr) {
  try {
    const conn = getConnection();
    const meta = await getTokenMetadata(conn, new PublicKey(mintStr));
    if (!meta) return null;
    return formatTokenLabel(meta.name, meta.symbol);
  } catch {
    return null;
  }
}

async function nameFromDexScreener(mintStr) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintStr}`, {
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return null;
  const json = await res.json();
  const pair = Array.isArray(json?.pairs) ? json.pairs[0] : null;
  const base = pair?.baseToken;
  if (!base) return null;
  // Prefer the side that matches our mint
  const token =
    base.address === mintStr
      ? base
      : pair?.quoteToken?.address === mintStr
        ? pair.quoteToken
        : base;
  return formatTokenLabel(token.name, token.symbol);
}

async function nameFromJupiter(mintStr) {
  const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mintStr)}`, {
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return null;
  const json = await res.json();
  const list = Array.isArray(json) ? json : [];
  const hit = list.find((t) => t?.id === mintStr || t?.address === mintStr) || list[0];
  if (!hit) return null;
  return formatTokenLabel(hit.name, hit.symbol);
}

const tokenNameCache = new Map(); // mint -> { label, at }

/** Resolve display name: Metaplex → Token-2022 → DexScreener → Jupiter → short mint. */
export async function getTokenMetadataName(mintStr) {
  const short = shortMint(mintStr);
  const cached = tokenNameCache.get(mintStr);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.label;

  const resolvers = [nameFromMetaplex, nameFromToken2022, nameFromDexScreener, nameFromJupiter];
  for (const resolve of resolvers) {
    try {
      const label = await resolve(mintStr);
      if (label) {
        tokenNameCache.set(mintStr, { label, at: Date.now() });
        return label;
      }
    } catch (e) {
      // try next source
    }
  }
  tokenNameCache.set(mintStr, { label: short, at: Date.now() });
  return short;
}

/**
 * Transfer `amountUi` tokens (human units) from treasury to recipient.
 * Supports classic SPL and Token-2022. Creates ATA if needed.
 */
export async function sendSplReward({ fromKeypair, toAddress, mint, amountUi }) {
  const conn = getConnection();
  const mintPk = new PublicKey(mint);
  const toPk = new PublicKey(toAddress);
  const programId = await resolveTokenProgramId(mintPk);
  const mintInfo = await getMint(conn, mintPk, 'confirmed', programId);
  const rawAmount = BigInt(Math.round(Number(amountUi) * 10 ** mintInfo.decimals));
  if (rawAmount <= 0n) throw new Error('Transfer amount must be positive');

  const fromAta = await getAssociatedTokenAddress(
    mintPk,
    fromKeypair.publicKey,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const toAta = await getAssociatedTokenAddress(
    mintPk,
    toPk,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction();
  const toInfo = await conn.getAccountInfo(toAta);
  if (!toInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        fromKeypair.publicKey,
        toAta,
        toPk,
        mintPk,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  tx.add(
    createTransferCheckedInstruction(
      fromAta,
      mintPk,
      toAta,
      fromKeypair.publicKey,
      rawAmount,
      mintInfo.decimals,
      [],
      programId
    )
  );

  const sig = await sendAndConfirmTransaction(conn, tx, [fromKeypair], {
    commitment: 'confirmed'
  });
  return { signature: sig, amountUi: Number(amountUi), decimals: mintInfo.decimals };
}

/** Cascading weights X..(X-n+1) normalized over total reward amount. */
export function cascadingShares(totalAmount, winnerCount) {
  const n = Math.max(0, Math.floor(Number(winnerCount) || 0));
  const total = Number(totalAmount);
  if (n <= 0 || !(total > 0)) return [];
  const weights = [];
  for (let i = 0; i < n; i++) weights.push(n - i);
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (total * w) / sum);
}
