export interface SteeringFile {
  file: string;
  controls: string;
}

export const STEERING_FILES: readonly SteeringFile[] = [
  {
    file: 'charter.md',
    controls:
      'How the Driver runs a voyage: the crew, the human gates and the lifecycle. Adapt the workflow wording to your team.',
  },
  {
    file: 'reviewer.md',
    controls:
      "The reviewer's rubric: what it reads, what it checks and how it gives a verdict. Add your language's and stack's review checks here.",
  },
  {
    file: 'permissions.json',
    controls:
      'Which tool calls agents may make without a card. Allow your build, test and lint commands by name.',
  },
  {
    file: 'profile.json',
    controls:
      'The active rules profile and your local rule levels. The profile supplies the standards doc and steering block every builder and the reviewer read at kickoff.',
  },
];
