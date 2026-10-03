import { describe, expect, it } from 'vitest';
import {
  EMPTY_SERVICES_FORM,
  forgeSummary,
  formOf,
  trackerOf,
} from '../../../src/widgets/project/services-form.js';
import { servicesRead } from './services-fixtures.js';

const CLI_TRACKER = {
  kind: 'tracker-cli',
  how: 'cli',
  command: 'tracker',
} as const;

describe('services form', () => {
  it('round-trips a stored tracker through the form', () => {
    const form = formOf(
      servicesRead({ tracker: CLI_TRACKER, publishes: true }),
    );

    expect(form).toEqual({
      kind: 'tracker-cli',
      how: 'cli',
      reach: 'tracker',
      notes: '',
      publishes: true,
    });
    expect(trackerOf(form)).toEqual({ tracker: CLI_TRACKER, error: null });
  });

  it('treats an empty kind as no tracker set here', () => {
    expect(trackerOf({ ...EMPTY_SERVICES_FORM, kind: '  ' })).toEqual({
      tracker: null,
      error: null,
    });
  });

  it('keeps none without a way to reach it and trims what it sends', () => {
    expect(
      trackerOf({ ...EMPTY_SERVICES_FORM, kind: ' none ', notes: ' x ' }),
    ).toEqual({ tracker: { kind: 'none', notes: 'x' }, error: null });
  });

  it('names a tracker that is missing its server', () => {
    const draft = trackerOf({
      ...EMPTY_SERVICES_FORM,
      kind: 'tracker-mcp',
      how: 'mcp',
    });

    expect(draft.tracker).toBeNull();
    expect(draft.error).toContain("how: 'mcp' needs a server");
  });

  it('describes the forge with and without an origin', () => {
    expect(forgeSummary(servicesRead())).toBe('GitHub at github.com (gh CLI)');
    expect(
      forgeSummary(
        servicesRead({
          forge: { forge: 'gitlab', host: null, cli: 'glab', name: 'GitLab' },
        }),
      ),
    ).toBe('GitLab, no origin remote read yet (glab CLI)');
  });
});
