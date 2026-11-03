import type { EventContext, RuleConditions } from './rule.types';

const lc = (s: string) => s.toLowerCase();
const containsAny = (text: string, needles: string[]) => needles.some((n) => lc(text).includes(lc(n)));
const equalsAny = (value: string | undefined, options: string[]) =>
  value !== undefined && options.some((o) => lc(o) === lc(value));

/**
 * Every non-empty condition must hold (AND); within one condition any value may match (OR).
 * A rule with no conditions matches every event of its type.
 */
export function matchesConditions(c: RuleConditions, ctx: EventContext): boolean {
  if (c.keywords.length && !containsAny(ctx.title, c.keywords)) return false;
  if (c.bodyKeywords.length && !containsAny(ctx.body, c.bodyKeywords)) return false;
  if (c.authors.length && !equalsAny(ctx.author, c.authors)) return false;
  if (c.labels.length && !c.labels.some((l) => equalsAny(l, ctx.labels))) return false;
  if (c.branches.length && !equalsAny(ctx.branch, c.branches)) return false;
  return true;
}

/** Fills `{{placeholders}}` in a user-written comment template. */
export function renderTemplate(template: string, ctx: EventContext): string {
  const vars: Record<string, string> = {
    author: ctx.author,
    title: ctx.title,
    repo: ctx.repoFullName,
    branch: ctx.branch ?? '',
    number: ctx.number !== undefined ? String(ctx.number) : '',
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => vars[key] ?? m);
}
