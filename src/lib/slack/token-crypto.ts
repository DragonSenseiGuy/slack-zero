import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function key(): Buffer {
  const value = process.env.SLACK_TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error('SLACK_TOKEN_ENCRYPTION_KEY is required');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) {
    throw new Error('SLACK_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64');
  }
  return decoded;
}

export function isEncryptedToken(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSlackToken(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${PREFIX}${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptSlackToken(envelope: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}:` !== PREFIX) {
    throw new Error('Slack token is not a supported encrypted envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[2], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[4], 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
