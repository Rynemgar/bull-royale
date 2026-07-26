import crypto from 'crypto';
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
  createTransferInstruction,
  getMint,
  getAccount,
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

export async function getTokenBalance(ownerPubkey, mintStr) {
  const conn = getConnection();
  const owner = new PublicKey(ownerPubkey);
  const mint = new PublicKey(mintStr);
  const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  try {
    const acct = await getAccount(conn, ata);
    const mintInfo = await getMint(conn, mint);
    const raw = Number(acct.amount);
    const ui = raw / 10 ** mintInfo.decimals;
    return { ui, raw: acct.amount, decimals: mintInfo.decimals };
  } catch {
    const mintInfo = await getMint(conn, mint).catch(() => null);
    return { ui: 0, raw: 0n, decimals: mintInfo?.decimals ?? 0 };
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

/** Best-effort Metaplex metadata name; falls back to short mint. */
export async function getTokenMetadataName(mintStr) {
  const short = `${mintStr.slice(0, 4)}…${mintStr.slice(-4)}`;
  try {
    const mint = new PublicKey(mintStr);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METADATA_PROGRAM_ID
    );
    const conn = getConnection();
    const info = await conn.getAccountInfo(pda);
    if (!info?.data) return short;
    const data = Buffer.from(info.data);
    // Skip key(1) + update auth(32) + mint(32)
    let offset = 1 + 32 + 32;
    const name = readBorshString(data, offset);
    if (!name.value) return short;
    offset = name.next;
    const symbol = readBorshString(data, offset);
    const cleanName = name.value.replace(/\0/g, '').trim();
    const cleanSymbol = symbol.value ? symbol.value.replace(/\0/g, '').trim() : '';
    if (cleanSymbol && cleanName) return `${cleanName} (${cleanSymbol})`;
    return cleanName || cleanSymbol || short;
  } catch {
    return short;
  }
}

/**
 * Transfer `amountUi` tokens (human units) from treasury to recipient.
 * Creates ATA if needed.
 */
export async function sendSplReward({ fromKeypair, toAddress, mint, amountUi }) {
  const conn = getConnection();
  const mintPk = new PublicKey(mint);
  const toPk = new PublicKey(toAddress);
  const mintInfo = await getMint(conn, mintPk);
  const rawAmount = BigInt(Math.round(Number(amountUi) * 10 ** mintInfo.decimals));
  if (rawAmount <= 0n) throw new Error('Transfer amount must be positive');

  const fromAta = await getAssociatedTokenAddress(
    mintPk,
    fromKeypair.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const toAta = await getAssociatedTokenAddress(
    mintPk,
    toPk,
    false,
    TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  tx.add(
    createTransferInstruction(
      fromAta,
      toAta,
      fromKeypair.publicKey,
      rawAmount,
      [],
      TOKEN_PROGRAM_ID
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
