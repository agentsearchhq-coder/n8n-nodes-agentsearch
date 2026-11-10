/**
 * Minimal, dependency-free x402 v2 "exact" payer for USDC on Base (EIP-3009
 * TransferWithAuthorization signed as EIP-712 typed data).
 *
 * n8n verified community nodes may not ship runtime dependencies, so this file
 * implements the three primitives the payment needs with only node:crypto:
 * keccak-256, secp256k1 ECDSA (RFC 6979 deterministic nonces, low-s, recoverable
 * v) and EIP-712 hashing. Its output is checked byte-for-byte against the
 * reference @x402/evm + viem client in the test suite.
 *
 * The private key is only used to sign; it is never logged or returned.
 */
import { createHmac, randomBytes } from 'crypto';

/* ----------------------------- keccak-256 ----------------------------- */

const MASK64 = (1n << 64n) - 1n;
const RC: bigint[] = [];
const ROT: number[] = [];
const PI: number[] = [];
(() => {
	let r = 1;
	for (let i = 0; i < 24; i++) {
		let c = 0n;
		for (let j = 0; j < 7; j++) {
			r = ((r << 1) ^ ((r >> 7) * 0x71)) % 256;
			if (r & 2) c ^= 1n << ((1n << BigInt(j)) - 1n);
		}
		RC.push(c);
	}
	let x = 1;
	let y = 0;
	for (let t = 0; t < 24; t++) {
		ROT[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64;
		[x, y] = [y, (2 * x + 3 * y) % 5];
	}
	ROT[0] = 0;
	for (let i = 0; i < 25; i++) {
		const xi = i % 5;
		const yi = Math.floor(i / 5);
		PI[i] = yi + 5 * ((2 * xi + 3 * yi) % 5);
	}
})();

const rotl = (v: bigint, n: number) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64);

function keccakF(s: bigint[]): void {
	const c: bigint[] = new Array(5);
	const b: bigint[] = new Array(25);
	for (let round = 0; round < 24; round++) {
		for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
		for (let x = 0; x < 5; x++) {
			const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
			for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
		}
		for (let i = 0; i < 25; i++) b[PI[i]] = rotl(s[i], ROT[i]);
		for (let y = 0; y < 25; y += 5) {
			for (let x = 0; x < 5; x++) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK64 & b[((x + 2) % 5) + y]);
		}
		s[0] ^= RC[round];
	}
}

export function keccak256(data: Uint8Array): Uint8Array {
	const rate = 136;
	const padLen = rate - (data.length % rate);
	const msg = new Uint8Array(data.length + padLen);
	msg.set(data);
	msg[data.length] ^= 0x01;
	msg[msg.length - 1] ^= 0x80;
	const s: bigint[] = new Array(25).fill(0n);
	for (let off = 0; off < msg.length; off += rate) {
		for (let i = 0; i < rate / 8; i++) {
			let lane = 0n;
			for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + k]);
			s[i] ^= lane;
		}
		keccakF(s);
	}
	const out = new Uint8Array(32);
	for (let i = 0; i < 4; i++) {
		let lane = s[i];
		for (let k = 0; k < 8; k++) {
			out[i * 8 + k] = Number(lane & 0xffn);
			lane >>= 8n;
		}
	}
	return out;
}

/* ------------------------------ bytes utils ----------------------------- */

export const toHex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/i, ''), 'hex'));
const bigToBytes = (n: bigint, len = 32) => fromHex(n.toString(16).padStart(len * 2, '0'));
const bytesToBig = (b: Uint8Array) => (b.length ? BigInt(toHex(b)) : 0n);
const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

/* ------------------------------- secp256k1 ------------------------------ */

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Point = {
	x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
	y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};
type Point = { x: bigint; y: bigint } | null;

const mod = (a: bigint, m: bigint) => {
	const r = a % m;
	return r >= 0n ? r : r + m;
};
function inv(a: bigint, m: bigint): bigint {
	let [lo, hi] = [mod(a, m), m];
	let [x0, x1] = [1n, 0n];
	while (lo > 1n) {
		const q = hi / lo;
		[lo, hi] = [hi - q * lo, lo];
		[x0, x1] = [x1 - q * x0, x0];
	}
	return mod(x0, m);
}
function add(p: Point, q: Point): Point {
	if (!p) return q;
	if (!q) return p;
	if (p.x === q.x) {
		if (mod(p.y + q.y, P) === 0n) return null;
		const l = mod(3n * p.x * p.x * inv(2n * p.y, P), P);
		const x = mod(l * l - 2n * p.x, P);
		return { x, y: mod(l * (p.x - x) - p.y, P) };
	}
	const l = mod((q.y - p.y) * inv(q.x - p.x, P), P);
	const x = mod(l * l - p.x - q.x, P);
	return { x, y: mod(l * (p.x - x) - p.y, P) };
}
function mul(k: bigint, p: Point): Point {
	let r: Point = null;
	let a = p;
	while (k > 0n) {
		if (k & 1n) r = add(r, a);
		a = add(a, a);
		k >>= 1n;
	}
	return r;
}

function hmac(key: Uint8Array, ...data: Uint8Array[]): Uint8Array {
	const h = createHmac('sha256', key);
	for (const d of data) h.update(d);
	return new Uint8Array(h.digest());
}

/** RFC 6979 deterministic k for secp256k1 / SHA-256 sized inputs. */
function rfc6979(d: bigint, h1: Uint8Array): bigint {
	const x = bigToBytes(d);
	const h = bigToBytes(mod(bytesToBig(h1), N));
	let v: Uint8Array = new Uint8Array(32).fill(1);
	let k: Uint8Array = new Uint8Array(32).fill(0);
	k = hmac(k, v, Uint8Array.of(0), x, h);
	v = hmac(k, v);
	k = hmac(k, v, Uint8Array.of(1), x, h);
	v = hmac(k, v);
	for (;;) {
		v = hmac(k, v);
		const t = bytesToBig(v);
		if (t >= 1n && t < N) return t;
		k = hmac(k, v, Uint8Array.of(0));
		v = hmac(k, v);
	}
}

/** Signs a 32-byte digest. Returns 65-byte r || s || v (v = 27 or 28), low-s. */
export function signDigest(digest: Uint8Array, privateKey: bigint): string {
	const z = mod(bytesToBig(digest), N);
	let k = rfc6979(privateKey, digest);
	for (;;) {
		const R = mul(k, G);
		if (R) {
			const r = mod(R.x, N);
			if (r !== 0n) {
				let s = mod(inv(k, N) * (z + r * privateKey), N);
				if (s !== 0n) {
					let rec = (R.y & 1n ? 1 : 0) | (R.x >= N ? 2 : 0);
					if (s > N / 2n) {
						s = N - s;
						rec ^= 1;
					}
					return toHex(concat(bigToBytes(r), bigToBytes(s), Uint8Array.of(27 + (rec & 1))));
				}
			}
		}
		k = mod(k + 1n, N); // practically unreachable
	}
}

/* ------------------------------- addresses ------------------------------ */

export function checksumAddress(addr: string): string {
	const a = addr.toLowerCase().replace(/^0x/, '');
	const h = Buffer.from(keccak256(utf8(a))).toString('hex');
	let out = '0x';
	for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
	return out;
}

/** Parses a 64-hex private key (optional 0x). Throws without echoing the value. */
export function parsePrivateKey(raw: string): bigint {
	const t = (raw ?? '').trim();
	if (!/^(0x)?[0-9a-fA-F]{64}$/.test(t)) {
		throw new Error('The wallet private key is not valid (expected 64 hex characters, optional 0x prefix). The value is not shown. Nothing was signed.');
	}
	const d = BigInt(t.startsWith('0x') || t.startsWith('0X') ? t : '0x' + t);
	if (d <= 0n || d >= N) throw new Error('The wallet private key is out of range. The value is not shown. Nothing was signed.');
	return d;
}

export function addressOf(privateKey: bigint): string {
	const Q = mul(privateKey, G);
	if (!Q) throw new Error('Invalid private key');
	const pub = concat(bigToBytes(Q.x), bigToBytes(Q.y));
	return checksumAddress(toHex(keccak256(pub).slice(12)));
}

/* -------------------------------- EIP-712 ------------------------------- */

const DOMAIN_TYPEHASH = keccak256(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const TWA_TYPEHASH = keccak256(
	utf8('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'),
);
const addr32 = (a: string) => bigToBytes(BigInt(a));

export interface Authorization {
	from: string;
	to: string;
	value: string;
	validAfter: string;
	validBefore: string;
	nonce: string;
}

export function transferWithAuthorizationDigest(
	domain: { name: string; version: string; chainId: number; verifyingContract: string },
	a: Authorization,
): Uint8Array {
	const ds = keccak256(
		concat(DOMAIN_TYPEHASH, keccak256(utf8(domain.name)), keccak256(utf8(domain.version)), bigToBytes(BigInt(domain.chainId)), addr32(domain.verifyingContract)),
	);
	const sh = keccak256(
		concat(
			TWA_TYPEHASH,
			addr32(a.from),
			addr32(a.to),
			bigToBytes(BigInt(a.value)),
			bigToBytes(BigInt(a.validAfter)),
			bigToBytes(BigInt(a.validBefore)),
			fromHex(a.nonce),
		),
	);
	return keccak256(concat(Uint8Array.of(0x19, 0x01), ds, sh));
}

/* ------------------------------ x402 payment ----------------------------- */

export const BASE_NETWORK = 'eip155:8453';
export const BASE_CHAIN_ID = 8453;
/** Native USDC on Base. */
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** The Pocket Agentic Portal payee for the AgentSearch services. */
export const PORTAL_PAYEE = '0xF732ea490c5766071785a2310523f7fA2CEbB829';
/** $0.005 in USDC atomic units: hard ceiling per call. */
export const MAX_PER_CALL_ATOMIC = 5000n;
/** AgentSearch's own x402 API on Base (opt-in "Payment Route: Direct"). */
export const DIRECT_URL = 'https://api.agentsearchhq.com';
export const DIRECT_PAYEE = '0xC49B157887e51c21CB655f39CF65D6a4c2a4C337';
/** $0.020 hard ceiling per direct call (extract $0.007, render $0.010, search_and_read $0.015). */
export const DIRECT_MAX_PER_CALL_ATOMIC = 20000n;

export interface PaymentRequirement {
	scheme: string;
	network: string;
	amount: string;
	asset: string;
	payTo: string;
	maxTimeoutSeconds?: number;
	extra?: { name?: string; version?: string; assetTransferMethod?: string; [k: string]: unknown };
}

export interface PaymentRequired {
	x402Version: number;
	resource?: { url?: string; [k: string]: unknown };
	accepts: PaymentRequirement[];
	extensions?: Record<string, unknown>;
}

const eqAddr = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

export function atomicToUsd(a: bigint | string): string {
	const n = BigInt(a);
	return `$${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, '0')}`;
}

/** Picks the single option this node is willing to sign, or explains why none qualifies. */
export function selectAccept(accepts: PaymentRequirement[], ceiling: bigint, payee: string = PORTAL_PAYEE): PaymentRequirement {
	const why: string[] = [];
	for (const a of accepts ?? []) {
		if (a.scheme !== 'exact') { why.push(`${a.scheme} scheme`); continue; }
		if (a.network !== BASE_NETWORK) { why.push(`network ${a.network}`); continue; }
		if (!eqAddr(a.asset, USDC_BASE)) { why.push(`asset ${a.asset} is not USDC on Base`); continue; }
		if (!eqAddr(a.payTo, payee)) { why.push(`payee ${a.payTo} is not ${payee === PORTAL_PAYEE ? "the portal's" : "AgentSearch's"}`); continue; }
		if ((a.extra?.assetTransferMethod ?? 'eip3009') !== 'eip3009') { why.push('not an EIP-3009 transfer'); continue; }
		if (!a.extra?.name || !a.extra?.version) { why.push('missing EIP-712 domain name/version'); continue; }
		if (!/^\d+$/.test(String(a.amount))) { why.push(`amount ${a.amount} is not an integer`); continue; }
		const amt = BigInt(a.amount);
		if (amt <= 0n) { why.push(`amount ${a.amount}`); continue; }
		if (amt > ceiling) { why.push(`amount ${atomicToUsd(amt)} is above the ${atomicToUsd(ceiling)} limit`); continue; }
		return a;
	}
	throw new Error(`Refusing to pay: no acceptable payment option (${why.join('; ') || 'none offered'}). Nothing was signed.`);
}

export function decodeBase64Json<T>(header: string): T {
	return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as T;
}

/**
 * Builds the x402 v2 PaymentPayload for one accepted requirement (same shape as
 * @x402/core x402Client.createPaymentPayload with the exact EVM scheme).
 * `now` and `nonce` are injectable for tests only.
 */
export function createPaymentPayload(
	required: PaymentRequired,
	accepted: PaymentRequirement,
	privateKey: bigint,
	opts: { now?: number; nonce?: string } = {},
): { payload: Record<string, unknown>; from: string } {
	const from = addressOf(privateKey);
	const now = opts.now ?? Math.floor(Date.now() / 1000);
	const authorization: Authorization = {
		from,
		to: checksumAddress(accepted.payTo),
		value: String(accepted.amount),
		validAfter: '0',
		validBefore: String(now + (accepted.maxTimeoutSeconds ?? 60)),
		nonce: opts.nonce ?? toHex(new Uint8Array(randomBytes(32))),
	};
	const digest = transferWithAuthorizationDigest(
		{ name: String(accepted.extra?.name), version: String(accepted.extra?.version), chainId: BASE_CHAIN_ID, verifyingContract: checksumAddress(accepted.asset) },
		authorization,
	);
	const signature = signDigest(digest, privateKey);
	const payload: Record<string, unknown> = {
		x402Version: 2,
		payload: { authorization, signature },
		extensions: required.extensions,
		resource: required.resource,
		accepted,
	};
	return { payload, from };
}

export const encodePaymentHeader = (payload: Record<string, unknown>) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
