import { z } from 'zod';

export const CLAUDE_AUTH_MODES = ['subscription', 'api_key', 'vertex'] as const;

export const claudeAuthModeSchema = z.enum(CLAUDE_AUTH_MODES);

export type ClaudeAuthMode = z.infer<typeof claudeAuthModeSchema>;

export const claudeAuthSourceSchema = z.enum(['env', 'file', 'default']);

export type ClaudeAuthSource = z.infer<typeof claudeAuthSourceSchema>;

export const claudeKeySourceSchema = z.enum(['env', 'keychain']);

export type ClaudeKeySource = z.infer<typeof claudeKeySourceSchema>;

export const claudeAuthStatusSchema = z.object({
  mode: claudeAuthModeSchema,
  source: claudeAuthSourceSchema,
  missing: z.array(z.string()),
  keySource: claudeKeySourceSchema.nullable(),
  gateway: z.boolean(),
});

export type ClaudeAuthStatus = z.infer<typeof claudeAuthStatusSchema>;
