import { describe, expect, it } from 'vitest';
import { emptyTables } from '../../../src/api/index.js';
import {
  globalVoyage,
  killAllLabel,
} from '../../../src/widgets/board/voyage-model.js';
import {
  IDLE_BUILDER_ID,
  RETIRED_ID,
  SITE_ID,
  VOYAGE_ID,
  agent,
  projectTables,
  ticket,
  voyage,
} from '../project/fixtures.js';

const SITE_VOYAGE_ID = '00000000-0000-4000-8000-0000000000b8';

describe('the global voyage', () => {
  it('has none without an open voyage', () => {
    expect(globalVoyage(emptyTables())).toBeNull();
    expect(killAllLabel(null)).toBe(
      'Kill all? This ends the voyage and reopens 0 tickets',
    );
  });

  it('reads the open voyage with every project it spans', () => {
    const tables = projectTables();
    tables.voyages.push(
      voyage(SITE_VOYAGE_ID, 2, {
        projectId: SITE_ID,
        projects: ['deck', 'site'],
      }),
    );
    expect(globalVoyage(tables)).toEqual({
      number: 2,
      label: 'Voyage 2 · active',
      goal: 'Ship the project widget',
      projects: ['deck', 'site'],
      reopenCount: 3,
      isCountPartial: false,
    });
  });

  it('says the count is this board’s when the voyage spans projects it does not stream', () => {
    const tables = projectTables();
    tables.voyages = tables.voyages.map((row) => ({
      ...row,
      projects: ['deck', 'elsewhere'],
    }));
    const partial = globalVoyage(tables);
    expect(partial?.isCountPartial).toBe(true);
    expect(killAllLabel(partial)).toBe(
      'Kill all? This ends the voyage and reopens 3 tickets here, and its tickets in the other projects',
    );
  });

  it('counts the tickets a kill would reopen: active ones held by the voyage builders, retired or not', () => {
    const tables = projectTables();
    const reopen = () => globalVoyage(tables)?.reopenCount;
    expect(reopen()).toBe(3);
    tables.tickets.push(ticket(7, IDLE_BUILDER_ID, 'assigned'));
    expect(reopen()).toBe(3);
    tables.tickets = tables.tickets.filter(
      ({ assigneeId }) => assigneeId !== RETIRED_ID,
    );
    expect(reopen()).toBe(2);
  });

  it('counts blocked tickets held by killed voyage builders', () => {
    const tables = projectTables();
    const killedId = '00000000-0000-4000-8000-0000000000c9';
    tables.agents.push(
      agent(killedId, 'petrel', { voyageId: VOYAGE_ID, status: 'killed' }),
    );
    tables.tickets.push(ticket(7, killedId, 'blocked'));
    expect(globalVoyage(tables)?.reopenCount).toBe(4);
    expect(killAllLabel(globalVoyage(tables))).toBe(
      'Kill all? This ends the voyage and reopens 4 tickets',
    );
  });

  it('takes the newest unended voyage, planning included', () => {
    const tables = projectTables();
    tables.voyages.push(
      voyage('00000000-0000-4000-8000-0000000000b3', 3, { status: 'planning' }),
    );
    expect(globalVoyage(tables)?.label).toBe('Voyage 3 · planning');
  });
});
