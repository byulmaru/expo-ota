import { z } from "zod";

const actionInputsSchema = z.object({
  exportDir: z.string().min(1),
  project: z.string().min(1).refine(
    (value) => value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value),
    'Input "project" must be one non-empty path segment',
  ),
  platform: z.enum(["ios", "android"], {
    error: 'Input "platform" must be ios or android',
  }),
  channel: z.enum(["dev", "prod", "staging", "production"], {
    error: 'Input "channel" must be dev, prod, staging, or production',
  }),
  runtimeVersion: z.string().min(1).refine(
    (value) => value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value),
    'Input "runtime-version" must be one non-empty path segment',
  ),
  publicBaseUrl: z
    .url({ protocol: /^https?$/u, error: 'Input "public-base-url" must be an absolute HTTP(S) URL' })
    .refine((value) => {
      const url = new URL(value);
      return !(url.username || url.password || url.search || url.hash);
    }, 'Input "public-base-url" must not contain credentials, query, or fragment')
    .transform((value) => value.replace(/\/+$/u, "")),
  r2Bucket: z.string().min(1),
  r2AccountId: z.string().min(1).regex(/^[A-Za-z0-9-]+$/u, {
    error: 'Input "r2-account-id" contains invalid characters',
  }),
  r2AccessKeyId: z.string().min(1),
  r2SecretAccessKey: z.string().min(1),
  signingPrivateKey: z.string().min(1),
  keyid: z.string().min(1).regex(/^[A-Za-z0-9*._-]+$/u, {
    error: 'Input "keyid" must be an SFV token',
  }),
});

export type ActionInputs = z.infer<typeof actionInputsSchema>;

function input(name: string, fallback?: string): string {
  const value = process.env[`INPUT_${name.toUpperCase()}`];
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required input "${name}"`);
}

export function parseActionInputs(value: unknown): ActionInputs {
  const parsed = actionInputsSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid Action inputs");
  return parsed.data;
}

export function readActionInputs(): ActionInputs {
  return parseActionInputs({
    exportDir: input("export-dir"),
    project: input("project"),
    platform: input("platform"),
    channel: input("channel"),
    runtimeVersion: input("runtime-version"),
    publicBaseUrl: input("public-base-url"),
    r2Bucket: input("r2-bucket"),
    r2AccountId: input("r2-account-id"),
    r2AccessKeyId: input("r2-access-key-id"),
    r2SecretAccessKey: input("r2-secret-access-key"),
    signingPrivateKey: input("signing-private-key"),
    keyid: input("keyid", "main"),
  });
}
