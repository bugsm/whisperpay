/**
 * Starknet ID domain encoding — the pure half.
 *
 * Kept free of any RPC or SDK import so the link codec can validate a `.stark`
 * label without dragging a provider into every bundle that touches a payment
 * request.
 *
 * Ported from the official `starknetid.js` (`packages/core/src/utils.ts`), which
 * pins `starknet@8.5.2` as a peer dependency and so can't be installed next to
 * our v10 without duplicating the SDK. Verified against live mainnet by
 * round-tripping name → address → name; see `docs/PRIVACY.md` and the resolver.
 */

const basicAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
const basicSizePlusOne = BigInt(basicAlphabet.length + 1);
const basicAlphabetSize = BigInt(basicAlphabet.length);
const bigAlphabet = "这来";
const bigAlphabetSize = BigInt(bigAlphabet.length);
const bigAlphabetSizePlusOne = BigInt(bigAlphabet.length + 1);
const ZERO = BigInt(0);

/** Longest `.stark` name we'll carry in a link. */
export const MAX_NAME_LENGTH = 100;

export function isStarkDomain(domain: string): boolean {
  return (
    domain.length <= MAX_NAME_LENGTH &&
    /^(?:[a-z0-9-]{1,48}(?:[a-z0-9-]{1,48}[a-z0-9-])?\.)*[a-z0-9-]{1,48}\.stark$/.test(
      domain
    )
  );
}

function extractStars(str: string): [string, number] {
  let count = 0;
  while (str.endsWith(bigAlphabet[bigAlphabet.length - 1])) {
    str = str.substring(0, str.length - 1);
    count += 1;
  }
  return [str, count];
}

function encode(decoded: string | undefined): bigint {
  let encoded = ZERO;
  let multiplier = BigInt(1);

  if (!decoded) return encoded;

  if (decoded.endsWith(bigAlphabet[0] + basicAlphabet[1])) {
    const [str, k] = extractStars(decoded.substring(0, decoded.length - 2));
    decoded = str + bigAlphabet[bigAlphabet.length - 1].repeat(2 * (k + 1));
  } else {
    const [str, k] = extractStars(decoded);
    if (k) {
      decoded = str + bigAlphabet[bigAlphabet.length - 1].repeat(1 + 2 * (k - 1));
    }
  }

  for (let i = 0; i < decoded.length; i += 1) {
    const char = decoded[i];
    const index = basicAlphabet.indexOf(char);

    if (index !== -1) {
      if (i === decoded.length - 1 && decoded[i] === basicAlphabet[0]) {
        encoded += multiplier * basicAlphabetSize;
        multiplier *= basicSizePlusOne;
        multiplier *= basicSizePlusOne;
      } else {
        encoded += multiplier * BigInt(index);
        multiplier *= basicSizePlusOne;
      }
    } else if (bigAlphabet.indexOf(char) !== -1) {
      encoded += multiplier * basicAlphabetSize;
      multiplier *= basicSizePlusOne;
      const newid = (i === decoded.length - 1 ? 1 : 0) + bigAlphabet.indexOf(char);
      encoded += multiplier * BigInt(newid);
      multiplier *= bigAlphabetSize;
    }
  }

  return encoded;
}

function decode(felt: bigint): string {
  let decoded = "";
  while (felt !== ZERO) {
    const code = felt % basicSizePlusOne;
    felt /= basicSizePlusOne;
    if (code === basicAlphabetSize) {
      const nextSubdomain = felt / bigAlphabetSizePlusOne;
      if (nextSubdomain === ZERO) {
        const code2 = felt % bigAlphabetSizePlusOne;
        felt = nextSubdomain;
        if (code2 === ZERO) decoded += basicAlphabet[0];
        else decoded += bigAlphabet[Number(code2) - 1];
      } else {
        const code2 = felt % bigAlphabetSize;
        decoded += bigAlphabet[Number(code2)];
        felt /= bigAlphabetSize;
      }
    } else {
      decoded += basicAlphabet[Number(code)];
    }
  }

  const [str, k] = extractStars(decoded);
  if (k) {
    decoded =
      str +
      (k % 2 === 0
        ? bigAlphabet[bigAlphabet.length - 1].repeat(k / 2 - 1) +
          bigAlphabet[0] +
          basicAlphabet[1]
        : bigAlphabet[bigAlphabet.length - 1].repeat((k - 1) / 2 + 1));
  }

  return decoded;
}

export function encodeDomain(domain: string): bigint[] {
  if (!domain) return [ZERO];
  return domain
    .replace(/\.stark$/, "")
    .split(".")
    .map((label) => encode(label));
}

export function decodeDomain(encoded: bigint[]): string {
  let decoded = "";
  for (const label of encoded) {
    decoded += decode(label);
    if (decoded) decoded += ".";
  }
  return decoded ? decoded.concat("stark") : decoded;
}
