import { matchesConditions, renderTemplate } from './rule-matcher';
import { EventContext, ruleConditionsSchema } from './rule.types';

const ctx: EventContext = {
  event: 'issues',
  installationId: 1,
  repoId: 2,
  repoFullName: 'octo/demo',
  number: 7,
  title: 'App crashes: BUG in login',
  body: 'Steps to reproduce: click login',
  author: 'Octocat',
  labels: ['triage'],
  url: 'https://github.com/octo/demo/issues/7',
};

const cond = (c: Partial<Record<string, string[]>>) => ruleConditionsSchema.parse(c);

describe('matchesConditions', () => {
  it('matches everything when there are no conditions', () => {
    expect(matchesConditions(cond({}), ctx)).toBe(true);
  });

  it('matches title keywords case-insensitively', () => {
    expect(matchesConditions(cond({ keywords: ['bug'] }), ctx)).toBe(true);
    expect(matchesConditions(cond({ keywords: ['feature'] }), ctx)).toBe(false);
  });

  it('treats values in one condition as OR', () => {
    expect(matchesConditions(cond({ keywords: ['feature', 'crash'] }), ctx)).toBe(true);
  });

  it('treats separate conditions as AND', () => {
    expect(matchesConditions(cond({ keywords: ['bug'], authors: ['someone-else'] }), ctx)).toBe(false);
    expect(matchesConditions(cond({ keywords: ['bug'], authors: ['octocat'] }), ctx)).toBe(true);
  });

  it('matches body keywords and labels', () => {
    expect(matchesConditions(cond({ bodyKeywords: ['reproduce'] }), ctx)).toBe(true);
    expect(matchesConditions(cond({ labels: ['TRIAGE'] }), ctx)).toBe(true);
    expect(matchesConditions(cond({ labels: ['wontfix'] }), ctx)).toBe(false);
  });

  it('requires a branch when a branch condition is set', () => {
    expect(matchesConditions(cond({ branches: ['main'] }), ctx)).toBe(false);
    expect(matchesConditions(cond({ branches: ['main'] }), { ...ctx, branch: 'main' })).toBe(true);
  });
});

describe('renderTemplate', () => {
  it('replaces known placeholders and leaves unknown ones', () => {
    expect(renderTemplate('Thanks @{{author}} for #{{number}} {{nope}}', ctx)).toBe('Thanks @Octocat for #7 {{nope}}');
  });
});
