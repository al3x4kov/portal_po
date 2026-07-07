import { describe, expect, it } from 'vitest';
import { RequirementService } from '../src/services/RequirementService.js';
import { LinkService } from '../src/services/LinkService.js';
import { ProjectService } from '../src/services/ProjectService.js';
import type { AiImportServiceDeps } from '../src/services/AiImportService.js';
import type { AggregateInput } from '../src/services/aiImport/aggregateStage.js';
import type { PopulateInput } from '../src/services/aiImport/populateStage.js';
import type { RelateInput } from '../src/services/aiImport/relateStage.js';
import type {
  LinkServicePort,
  ProjectServicePort,
  RequirementServicePort,
} from '../src/services/ports.js';

/**
 * ARCH-9 conformance suite. Pins the service facade (`*ServicePort`) as the
 * stable contract the three adapters (REST routes, MCP tools, AiImportService)
 * depend on. Guards two directions:
 *  - the concrete service classes still satisfy their port (contract intact);
 *  - the adapters/factories accept ANY object implementing the port (a minimal
 *    fake with no private state), so a signature change on the class cannot
 *    silently leak into the adapter surface.
 * Pure structural/type layer — no behaviour is exercised (that lives in the
 * existing business suites).
 */

/** Compile-time: `U` must be assignable to `T`. Fails to typecheck otherwise. */
type AssertAssignable<T, U extends T> = U;

// The concrete classes remain assignable to their ports (redundant with the
// `implements` clause, but pins the contract from the consumer's side too).
type _ReqConforms = AssertAssignable<RequirementServicePort, RequirementService>;
type _LinkConforms = AssertAssignable<LinkServicePort, LinkService>;
type _ProjConforms = AssertAssignable<ProjectServicePort, ProjectService>;

/** Minimal fakes: implement the port surface only, with no private internals. */
const fakeReqPort: RequirementServicePort = {
  list: () => Promise.resolve({ requirements: [], broken: [], incomplete: [] }),
  checkName: () => Promise.resolve({ available: true, slug: 'x' }),
  create: () => Promise.reject(new Error('not implemented')),
  update: () => Promise.reject(new Error('not implemented')),
  delete: () => Promise.resolve({ deleted: [] }),
};

const fakeLinkPort: LinkServicePort = {
  create: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};

const fakeProjectPort: ProjectServicePort = {
  list: () => Promise.resolve([]),
  get: () => Promise.reject(new Error('not implemented')),
  create: () => Promise.reject(new Error('not implemented')),
  deleteProject: () => Promise.resolve(),
  export: () => Promise.reject(new Error('not implemented')),
  exportSelected: () => Promise.reject(new Error('not implemented')),
  import: () => Promise.reject(new Error('not implemented')),
};

describe('service ports (ARCH-9 conformance)', () => {
  it('concrete services expose every method declared by their port', () => {
    const reqMethods: Array<keyof RequirementServicePort> = [
      'list',
      'checkName',
      'create',
      'update',
      'delete',
    ];
    for (const m of reqMethods) {
      expect(typeof RequirementService.prototype[m]).toBe('function');
    }

    const linkMethods: Array<keyof LinkServicePort> = ['create', 'remove'];
    for (const m of linkMethods) {
      expect(typeof LinkService.prototype[m]).toBe('function');
    }

    const projMethods: Array<keyof ProjectServicePort> = [
      'list',
      'get',
      'create',
      'deleteProject',
      'export',
      'exportSelected',
      'import',
    ];
    for (const m of projMethods) {
      expect(typeof ProjectService.prototype[m]).toBe('function');
    }
  });

  it('AiImportService deps are typed against the ports (fakes accepted)', () => {
    // Compiles only if the deps use `*ServicePort`, not the concrete class: a
    // minimal fake port lacks the classes' private fields.
    const makeReq: AiImportServiceDeps['makeRequirementService'] = () => fakeReqPort;
    const makeLink: AiImportServiceDeps['makeLinkService'] = () => fakeLinkPort;
    expect(makeReq('p')).toBe(fakeReqPort);
    expect(makeLink('p')).toBe(fakeLinkPort);
  });

  it('AI-import stages accept port fakes for their service collaborators', () => {
    const aggregate: Pick<AggregateInput, 'requirementService'> = {
      requirementService: fakeReqPort,
    };
    const populate: Pick<PopulateInput, 'requirementService' | 'linkService'> = {
      requirementService: fakeReqPort,
      linkService: fakeLinkPort,
    };
    const relate: Pick<RelateInput, 'requirementService' | 'linkService'> = {
      requirementService: fakeReqPort,
      linkService: fakeLinkPort,
    };
    expect(aggregate.requirementService).toBe(fakeReqPort);
    expect(populate.linkService).toBe(fakeLinkPort);
    expect(relate.requirementService).toBe(fakeReqPort);
  });

  it('project port fake satisfies the contract shape', () => {
    expect(typeof fakeProjectPort.export).toBe('function');
    expect(typeof fakeProjectPort.exportSelected).toBe('function');
  });
});
