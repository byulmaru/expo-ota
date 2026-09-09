import { parseDictionary } from "structured-headers";
import { z } from "zod";

export const PROTOCOL_VERSION = "1" as const;
export const SFV_VERSION = "0" as const;
export const DEFAULT_MANIFEST_CACHE_CONTROL = "private, no-store";
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

const SIGNING_ALGORITHM = "rsa-v1_5-sha256" as const;
const PATH_SEGMENT = /^[^/\\\u0000-\u001f\u007f]+$/;
const MIME_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const platformSchema = z.enum(["ios", "android"]);
export const pathSegmentSchema = z.string().min(1).regex(PATH_SEGMENT).refine((value) => value !== "." && value !== "..");

export const manifestParamsSchema = z.object({
  project: pathSegmentSchema,
  platform: platformSchema,
  channel: z.enum(["staging", "production"]),
  runtime: pathSegmentSchema,
});

export const contentTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => MIME_TYPE.test(value.split(";", 1)[0]?.trim() ?? ""));
export const contentEncodingSchema = z.union([z.undefined(), z.literal(""), z.string().regex(/^identity$/i)]);

export type ParsedSignature = {
  keyid: string;
  alg: typeof SIGNING_ALGORITHM;
};

export type SignatureExpectation = {
  keyid?: string;
  alg?: typeof SIGNING_ALGORITHM;
};

const emptyParametersSchema = z.instanceof(Map).refine((parameters) => parameters.size === 0);

function parseSfvDictionary(value: unknown): Record<string, unknown> | undefined {
  const input = z.string().safeParse(value);
  if (!input.success) return undefined;
  try {
    return Object.fromEntries(parseDictionary(input.data));
  } catch {
    return undefined;
  }
}

export function parseSignature(value: unknown): ParsedSignature | undefined {
  const result = z
    .object({
      sig: z.tuple([z.string().min(1), emptyParametersSchema]),
      keyid: z.tuple([z.string().min(1), emptyParametersSchema]),
      alg: z.tuple([z.literal(SIGNING_ALGORITHM), emptyParametersSchema]),
    })
    .strict()
    .safeParse(parseSfvDictionary(value));
  if (!result.success) return undefined;
  return { keyid: result.data.keyid[0], alg: result.data.alg[0] };
}

export function parseSignatureExpectation(value: string): SignatureExpectation | undefined {
  const result = z
    .object({
      sig: z.tuple([z.literal(true), emptyParametersSchema]),
      keyid: z.tuple([z.string(), emptyParametersSchema]).optional(),
      alg: z.tuple([z.literal(SIGNING_ALGORITHM), emptyParametersSchema]).optional(),
    })
    .strict()
    .safeParse(parseSfvDictionary(value));
  if (!result.success) return undefined;
  return {
    ...(result.data.keyid === undefined ? {} : { keyid: result.data.keyid[0] }),
    ...(result.data.alg === undefined ? {} : { alg: result.data.alg[0] }),
  };
}

export function accepts(contentType: string, accept: string | undefined): boolean {
  if (!accept) return true;

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  let bestSpecificity = -1;
  let bestQuality = 0;
  for (const entry of accept.split(",")) {
    const [rawCandidate, ...parameters] = entry.trim().toLowerCase().split(";");
    const candidate = rawCandidate?.trim() ?? "";
    if (!candidate) continue;

    const rawQuality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const quality = z.coerce.number().finite().nonnegative().safeParse(rawQuality?.trim().slice(2) ?? "1");
    if (!quality.success) continue;
    const qualityValue = quality.data;

    const specificity =
      candidate === mediaType ? 2 : candidate === `${mediaType.split("/", 1)[0]}/*` ? 1 : candidate === "*/*" ? 0 : -1;
    if (specificity < 0) continue;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQuality = qualityValue;
    } else if (specificity === bestSpecificity) {
      bestQuality = Math.max(bestQuality, qualityValue);
    }
  }
  return bestSpecificity >= 0 && bestQuality > 0;
}
