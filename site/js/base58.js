// Base58, so that decoding an account does not need a library.
//
// The point of splitting this out is that everything which decides what a
// number *is* — the account decoders in program.js, the standing in
// standing.js — can then be imported and tested in Node with no dependency at
// all. Only address *derivation* needs web3.js, and that is isolated in
// addresses.js where the tests do not reach.
//
// `scripts/tests/site.test.mjs` checks these against `@solana/web3.js`'s own
// PublicKey on random bytes, so "no dependency" does not mean "no oracle".

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

/**
 * Bytes → base58, big-endian, with leading zero bytes preserved as '1's.
 *
 * The leading-zero rule is the part that is easy to miss and impossible to
 * notice: a pubkey whose first byte is zero would otherwise render one
 * character short and look like a different, plausible address.
 */
export function encodeBase58(bytes) {
  const input = Uint8Array.from(bytes);
  if (input.length === 0) return '';

  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;

  // Repeated division by 58 over a little-endian digit array. It starts EMPTY,
  // not [0]: seeding it with a zero digit appends a spurious '1' to every
  // result, which is invisible on a normal key and turns the all-zero key into
  // 33 characters. The test suite catches exactly that case.
  const digits = [];
  for (let i = zeros; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/** base58 → bytes. Throws on any character outside the alphabet. */
export function decodeBase58(text) {
  if (text === '') return new Uint8Array(0);

  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;

  const bytes = []; // empty, not [0] — same reason as the encoder above
  for (let i = zeros; i < text.length; i++) {
    const value = INDEX.get(text[i]);
    if (value === undefined) {
      throw new Error(`not base58: ${JSON.stringify(text[i])} at position ${i}`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/** 32 bytes at `offset`, as the base58 string a Solana address is written in. */
export function pubkeyAt(bytes, offset) {
  return encodeBase58(bytes.subarray(offset, offset + 32));
}
