import { describe, expect, it } from 'vitest';
import {
  TICKET_SPEC_FORMAT,
  parseTicketSpec,
  proposalProblems,
  specBody,
  specProblems,
} from '../../src/planner/index.js';
import { FAKE_SPEC_BODY as SPEC_BODY } from '../acp/fake-agent/index.ts';

const without = (heading: string): string =>
  SPEC_BODY.replace(new RegExp(`## ${heading}\\n\\n[^#]*`), '');

describe('ticket spec', () => {
  it('accepts a body with requirements, design, tasks and a Proven line', () => {
    expect(specProblems(SPEC_BODY)).toEqual([]);
    expect(
      proposalProblems({ title: 'Greet', body: SPEC_BODY, dependsOn: [] }),
    ).toEqual([]);
  });

  it('names every section a body is missing', () => {
    expect(specProblems(without('Design'))).toEqual([
      'it has no `## Design` section',
    ]);
    expect(specProblems('Say hello in the README.')).toEqual([
      'it has no `## Requirements` section',
      'it has no `## Design` section',
      'it has no `## Tasks` section',
      'its last line is not a `Proven: <observable check>` line',
    ]);
  });

  it('wants the Proven line last and not empty', () => {
    const lines = SPEC_BODY.split('\n');
    const proven = lines.at(-1) ?? '';
    const moved = [proven, ...lines.slice(0, -1)].join('\n');
    expect(specProblems(moved)).toEqual([
      'its last line is not a `Proven: <observable check>` line',
    ]);
    expect(specProblems(`${lines.slice(0, -1).join('\n')}\nProven:  `)).toEqual(
      ['its `Proven:` line is empty'],
    );
  });

  it('wants the sections in order, once each, with content', () => {
    const swapped = SPEC_BODY.replace('## Requirements', '## Swap')
      .replace('## Design', '## Requirements')
      .replace('## Swap', '## Design');
    expect(specProblems(swapped)).toEqual([
      'its sections are not in the order Requirements, Design, Tasks',
      'its requirements have no acceptance criterion (WHEN ... THE SYSTEM SHALL ...)',
    ]);
    const twice = SPEC_BODY.replace(
      'Proven:',
      '## Tasks\n\n1. Again.\n\nProven:',
    );
    expect(specProblems(twice)).toEqual([
      'it has more than one `## Tasks` section',
    ]);
    expect(
      specProblems(SPEC_BODY.replace(/## Design\n\n[^#]*/, '## Design\n\n')),
    ).toEqual(['its `## Design` section is empty']);
  });

  it('wants acceptance criteria and a numbered task list', () => {
    expect(
      specProblems(SPEC_BODY.replace('THE SYSTEM SHALL', 'the README')),
    ).toEqual([
      'its requirements have no acceptance criterion (WHEN ... THE SYSTEM SHALL ...)',
    ]);
    expect(specProblems(SPEC_BODY.replace(/^\d\. /gm, '- '))).toEqual([
      'its tasks are not a numbered list',
    ]);
  });

  it('parses the sections and writes them back', () => {
    const spec = parseTicketSpec(`Pairs with QD3.\n\n${SPEC_BODY}`);
    expect(spec).toEqual({
      intro: 'Pairs with QD3.',
      sections: {
        Requirements: expect.stringContaining('THE SYSTEM SHALL'),
        Design: 'Edit README.md only.',
        Tasks: '1. Add the greeting.\n2. Test that it shows.',
      },
      proven: 'the README starts with Hello.',
    });
    if (!spec) throw new Error('no spec');
    expect(parseTicketSpec(specBody(spec))).toEqual(spec);
    expect(parseTicketSpec('Say hello.')).toBeNull();
  });

  it('describes a template that passes its own check', () => {
    const template = /```markdown\n([\s\S]*?)```/.exec(TICKET_SPEC_FORMAT)?.[1];
    expect(specProblems(template ?? '')).toEqual([]);
  });
});
