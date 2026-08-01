// Signed invite links.
// The relay signs the payload with a per-workspace secret (HMAC-SHA256).
// The link is verifiable offline by the relay. No third party is needed.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const InvitePayloadSchema = z.object({
  workspace_id: z.string().min(1),
  invitee: z.string().min(1).max(100),
  expires_at: z.string().datetime(),
  nonce: z.string().min(8)
});
export type InvitePayload = z.infer<typeof InvitePayloadSchema>;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(data: string, secret: Buffer): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

/** Create a signed invite token. */
export function mintInvite(payload: InvitePayload, secret: Buffer): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body, secret)}`;
}

export type InviteVerification =
  | { ok: true; payload: InvitePayload }
  | { ok: false; reason: "bad_format" | "bad_signature" | "expired" };

/** Verify a signed invite token. Checks signature first, then expiry. */
export function verifyInvite(
  token: string,
  secret: Buffer,
  now: Date = new Date()
): InviteVerification {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "bad_format" };
  }
  const [body, sig] = parts;
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: InvitePayload;
  try {
    const json: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const parsed = InvitePayloadSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "bad_format" };
    payload = parsed.data;
  } catch {
    return { ok: false, reason: "bad_format" };
  }
  if (new Date(payload.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
