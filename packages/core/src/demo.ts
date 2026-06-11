import { createIpcError, createIpcora } from '.';
import type { IpcRequest, IpcResponse, IpcTransport, StandardSchemaV1 } from '.';

type DemoHandler = (
  event: { sender: { id: number } },
  request: IpcRequest,
) => IpcResponse | Promise<IpcResponse>;

type DemoPeerContext = {
  tenant: string;
};

type DemoUser = {
  id: string;
  role: 'admin' | 'member';
};

type DemoMetadata = {
  traceId?: string;
  user?: DemoUser;
};

type CreateProjectParams = {
  name: string;
  private: boolean;
};

type ProjectOutput = {
  id: string;
  name: string;
  ownerTenant: string;
  traceId: string;
  createdBy: string;
};

type DemoRequest<TParams = unknown> = Omit<IpcRequest, 'params' | 'metadata'> & {
  params?: TParams;
  metadata?: DemoMetadata;
};

function schema<TOutput>(
  validate: (
    value: unknown,
  ) =>
    | { value: TOutput; issues?: undefined }
    | { issues: readonly { message: string; path?: readonly unknown[] }[] },
): StandardSchemaV1<unknown, TOutput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'demo',
      validate,
    },
  };
}

function readDemoUser(metadata: Readonly<Record<string, unknown>>): DemoUser | undefined {
  return (metadata as DemoMetadata).user;
}

function createProjectRequest(request: DemoRequest<CreateProjectParams>): IpcRequest {
  return request;
}

function healthRequest(request: Omit<DemoRequest, 'params'>): IpcRequest {
  return request;
}

const createProjectParams = schema<CreateProjectParams>(value => {
  if (!value || typeof value !== 'object') {
    return { issues: [{ message: 'Expected an object' }] };
  }

  const params = value as Record<string, unknown>;
  if (typeof params.name !== 'string' || params.name.length === 0) {
    return { issues: [{ message: 'Expected a project name', path: ['name'] }] };
  }
  if (typeof params.private !== 'boolean') {
    return { issues: [{ message: 'Expected a privacy flag', path: ['private'] }] };
  }

  return {
    value: {
      name: params.name,
      private: params.private,
    },
  };
});

const projectOutput = schema<ProjectOutput>(value => {
  if (!value || typeof value !== 'object') {
    return { issues: [{ message: 'Expected an object response' }] };
  }

  const output = value as Record<string, unknown>;
  const keys = ['id', 'name', 'ownerTenant', 'traceId', 'createdBy'];
  const invalidKey = keys.find(key => typeof output[key] !== 'string');
  if (invalidKey) {
    return { issues: [{ message: `Expected ${invalidKey} to be a string`, path: [invalidKey] }] };
  }

  return {
    value: {
      id: output.id as string,
      name: output.name as string,
      ownerTenant: output.ownerTenant as string,
      traceId: output.traceId as string,
      createdBy: output.createdBy as string,
    },
  };
});

export function createMemoryTransport() {
  const handlers = new Map<string, DemoHandler>();
  const transport: IpcTransport = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    listenerCount(channel) {
      return handlers.has(channel) ? 1 : 0;
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };

  const invoke = async (
    channel: string,
    senderId: number,
    request: IpcRequest,
  ): Promise<IpcResponse> => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for ${channel}`);
    }
    return handler({ sender: { id: senderId } }, request);
  };

  return { invoke, transport };
}

export function createDemoIpcora() {
  const memory = createMemoryTransport();
  const state: { projectCount: number } = {
    projectCount: 0,
  };
  const ipcora = createIpcora<DemoPeerContext>({
    channel: 'demo:ipcora',
    transport: memory.transport,
  })
    .state(state)
    .decorate({
      serviceName: 'project-service',
    })
    .derive(({ rawParams }) => {
      return { rawParamsKind: typeof rawParams };
    })
    .resolve(() => {
      return { receivedAt: Date.now() };
    })
    .use<{ traceId: string }>(({ metadata }, next) => {
      return next({ traceId: String(metadata.traceId ?? 'trace-demo') });
    })
    .macro('requireRole', {
      onGuard({ metadata, option, error }) {
        const user = readDemoUser(metadata);
        if (!user) {
          throw error('UNAUTHORIZED', { message: 'Missing user metadata' });
        }
        if (user.role !== option) {
          throw error('FORBIDDEN', { message: `Expected ${option} role` });
        }
        return { user };
      },
    })
    .handler(
      'project.create',
      ({ store, tenant, traceId, user, params }) => {
        store.projectCount += 1;

        return {
          id: `${tenant}-${store.projectCount}`,
          name: params.name,
          ownerTenant: tenant,
          traceId,
          createdBy: user.id,
        };
      },
      {
        params: createProjectParams,
        output: projectOutput,
        requireRole: 'admin',
        onAfterHandle({ rawParamsKind, output }) {
          if (rawParamsKind !== 'object') {
            throw createIpcError('INVALID_INPUT_KIND');
          }
          return output;
        },
      },
    )
    .handler('system.health', ({ serviceName, receivedAt }) => {
      return {
        ok: true,
        service: serviceName,
        receivedAt,
      };
    });

  ipcora.bind(
    {
      id: 1,
      sender: { id: 1 },
    },
    {
      context: {
        tenant: 'acme',
      },
    },
  );

  return {
    channel: ipcora.channel,
    invoke: memory.invoke,
    ipcora,
  };
}

export async function runDemo() {
  const demo = createDemoIpcora();

  const createdProject = await demo.invoke(
    demo.channel,
    1,
    createProjectRequest({
      id: 'request-1',
      path: 'project.create',
      params: {
        name: 'Launch Plan',
        private: true,
      },
      metadata: {
        traceId: 'trace-001',
        user: {
          id: 'user-1',
          role: 'admin',
        },
      },
    }),
  );

  const rejectedProject = await demo.invoke(
    demo.channel,
    1,
    createProjectRequest({
      id: 'request-2',
      path: 'project.create',
      params: {
        name: 'Budget',
        private: false,
      },
      metadata: {
        user: {
          id: 'user-2',
          role: 'member',
        },
      },
    }),
  );

  const health = await demo.invoke(
    demo.channel,
    1,
    healthRequest({
      id: 'request-3',
      path: 'system.health',
    }),
  );

  demo.ipcora.dispose();

  return {
    createdProject,
    rejectedProject,
    health,
  };
}
