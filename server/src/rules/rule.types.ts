import { z } from 'zod';

const list = z
  .array(z.string().trim().min(1).max(100))
  .max(20)
  .default([])
  .transform((xs) => [...new Set(xs)]);

export const ruleConditionsSchema = z.object({
  /** Any of these appears in the title (issues/PRs) or a commit message (push). */
  keywords: list,
  /** Any of these appears in the issue/PR body. */
  bodyKeywords: list,
  /** Author login is one of these. */
  authors: list,
  /** The issue/PR already has one of these labels when opened. */
  labels: list,
  /** Push branch, or PR base branch, is one of these. */
  branches: list,
});

export const ruleActionsSchema = z.object({
  addLabels: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
  comment: z.string().trim().max(2000).nullable().default(null),
  slack: z.boolean().default(false),
  /** Run the AI triage step and include its summary in the comment / Slack message. */
  ai: z.boolean().default(false),
  /** Also apply the AI-suggested label (implies `ai`). */
  applyAiLabel: z.boolean().default(false),
});

export const RULE_EVENTS = ['issues', 'pull_request', 'push'] as const;

export const ruleInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  event: z.enum(RULE_EVENTS),
  repoId: z
    .union([z.string().regex(/^\d+$/), z.number().int().positive()])
    .nullable()
    .default(null),
  conditions: ruleConditionsSchema.default(ruleConditionsSchema.parse({})),
  actions: ruleActionsSchema,
});

export type RuleConditions = z.infer<typeof ruleConditionsSchema>;
export type RuleActions = z.infer<typeof ruleActionsSchema>;
export type RuleInput = z.infer<typeof ruleInputSchema>;
export type RuleEvent = (typeof RULE_EVENTS)[number];

/** Normalised view of a GitHub event that rules are evaluated against. */
export interface EventContext {
  event: RuleEvent;
  installationId: number;
  repoId: number;
  repoFullName: string;
  /** Issue / PR number. Absent for push. */
  number?: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  branch?: string;
  url: string;
  /** Head commit for push events (comments go on the commit). */
  headSha?: string;
}
