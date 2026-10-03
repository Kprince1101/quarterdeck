export const SPEC_SECTIONS = ['Requirements', 'Design', 'Tasks'] as const;

export type SpecSection = (typeof SPEC_SECTIONS)[number];

export const PROVEN_PREFIX = 'Proven:';

export interface TicketSpec {
  intro: string;
  sections: Record<SpecSection, string>;
  proven: string;
}

export interface ProposalDraft {
  title: string;
  body: string;
  dependsOn: readonly string[];
}

export const TICKET_SPEC_FORMAT = `Write every ticket body as a spec: these parts, in this order, with nothing after the \`${PROVEN_PREFIX}\` line.

\`\`\`markdown
## Requirements

- As a <role>, I want <goal>, so that <reason>.
  - WHEN <condition> THE SYSTEM SHALL <behaviour>.

## Design

Where in the repository the change goes, the approach, and the constraints and decisions to follow, including what must not be touched.

## Tasks

1. <first step>
2. <next step>

${PROVEN_PREFIX} <one observable check that shows the ticket is done>
\`\`\`

- Requirements: user stories, each with acceptance criteria in the form WHEN ... THE SYSTEM SHALL ....
- Design: where the work goes, the approach, and the constraints and decisions.
- Tasks: a numbered checklist the builder works in order, sized for one pull request.
- ${PROVEN_PREFIX} the last line, one check anyone can observe once the ticket is done.`;

const HEADING = /^##[^\S\n]+(.+?)\s*$/;
const PROVEN_LINE = /^Proven:(.*)$/;
const CRITERION = /\bSHALL\b/;
const TASK_ITEM = /^\s*\d+[.)]\s+\S/m;

interface SpecScan {
  intro: string[];
  order: SpecSection[];
  content: Partial<Record<SpecSection, string[]>>;
  proven: string | null;
}

const sectionOf = (line: string): SpecSection | undefined => {
  const name = HEADING.exec(line)?.[1]?.toLowerCase();
  return SPEC_SECTIONS.find((section) => section.toLowerCase() === name);
};

interface ProvenSplit {
  lines: string[];
  proven: string | null;
}

const splitProven = (body: string): ProvenSplit => {
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  const last = lines.findLastIndex((line) => line.trim() !== '');
  const proven = PROVEN_LINE.exec(lines[last]?.trim() ?? '');
  if (!proven) return { lines, proven: null };
  return { lines: lines.slice(0, last), proven: (proven[1] ?? '').trim() };
};

const scanSpec = (body: string): SpecScan => {
  const { lines, proven } = splitProven(body);
  const scan: SpecScan = { intro: [], order: [], content: {}, proven };
  lines.forEach((line) => {
    const section = sectionOf(line);
    if (section) {
      scan.order.push(section);
      scan.content[section] ??= [];
      return;
    }
    const current = scan.order.at(-1);
    if (current === undefined) scan.intro.push(line);
    else scan.content[current]?.push(line);
  });
  return scan;
};

const joined = (lines: readonly string[] | undefined): string =>
  (lines ?? []).join('\n').trim();

const sectionProblems = (scan: SpecScan): string[] =>
  SPEC_SECTIONS.flatMap((section) => {
    const seen = scan.order.filter((name) => name === section).length;
    if (seen === 0) return [`it has no \`## ${section}\` section`];
    if (seen > 1) return [`it has more than one \`## ${section}\` section`];
    if (joined(scan.content[section]) === '')
      return [`its \`## ${section}\` section is empty`];
    return [];
  });

const orderProblems = (scan: SpecScan): string[] => {
  const present = SPEC_SECTIONS.filter((section) =>
    scan.order.includes(section),
  );
  if ([...new Set(scan.order)].join() === present.join()) return [];
  return [`its sections are not in the order ${SPEC_SECTIONS.join(', ')}`];
};

const contentProblems = (scan: SpecScan): string[] => {
  const problems: string[] = [];
  const requirements = joined(scan.content.Requirements);
  if (requirements !== '' && !CRITERION.test(requirements))
    problems.push(
      'its requirements have no acceptance criterion (WHEN ... THE SYSTEM SHALL ...)',
    );
  const tasks = joined(scan.content.Tasks);
  if (tasks !== '' && !TASK_ITEM.test(tasks))
    problems.push('its tasks are not a numbered list');
  return problems;
};

const provenProblems = (scan: SpecScan): string[] => {
  if (scan.proven === null)
    return [
      `its last line is not a \`${PROVEN_PREFIX} <observable check>\` line`,
    ];
  if (scan.proven === '') return [`its \`${PROVEN_PREFIX}\` line is empty`];
  return [];
};

export const specProblems = (body: string): string[] => {
  const scan = scanSpec(body);
  return [
    ...sectionProblems(scan),
    ...orderProblems(scan),
    ...contentProblems(scan),
    ...provenProblems(scan),
  ];
};

export const proposalProblems = (proposal: ProposalDraft): string[] =>
  specProblems(proposal.body);

export const describeProblems = (problems: readonly string[]): string =>
  `the ticket does not follow the spec format: ${problems.join('; ')}`;

export const parseTicketSpec = (body: string): TicketSpec | null => {
  if (specProblems(body).length > 0) return null;
  const scan = scanSpec(body);
  return {
    intro: joined(scan.intro),
    sections: {
      Requirements: joined(scan.content.Requirements),
      Design: joined(scan.content.Design),
      Tasks: joined(scan.content.Tasks),
    },
    proven: scan.proven ?? '',
  };
};

const introBlocks = (intro: string): string[] => {
  const text = intro.trim();
  if (text === '') return [];
  return [text];
};

export const specBody = (spec: TicketSpec): string =>
  [
    ...introBlocks(spec.intro),
    ...SPEC_SECTIONS.map(
      (section) => `## ${section}\n\n${spec.sections[section].trim()}`,
    ),
    `${PROVEN_PREFIX} ${spec.proven.trim()}`,
  ].join('\n\n');
