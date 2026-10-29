import type {
  ApiErrorBody,
  ApprovalDto,
  AttachmentDto,
  CodeMapStatusDto,
  FileChangeDto,
  HostEnvironment,
  LogSourceDto,
  MemoryCategory,
  MemoryDto,
  MemoryScope,
  MemorySettingsDto,
  SshHostDto,
  ConnectionTestResult,
  FileViewDto,
  ProjectDto,
  ProjectOverviewDto,
  ProcessDto,
  ProcessOutputDto,
  SandboxSettings,
  SandboxStatusDto,
  SystemInfoDto,
  TreeEntryDto,
  MessageDto,
  ModelCapabilities,
  ModelInfo,
  ProviderCallDto,
  RunDto,
  SessionDetailDto,
  SessionSummaryDto,
  SettingsDto,
} from '@friday/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  // Required by the server's CSRF guard on mutating requests.
  if (method !== 'GET') headers['x-friday-client'] = '1';
  // Blobs (image uploads) are sent as they are, with their own type.
  const raw = body instanceof Blob;
  if (body !== undefined) headers['content-type'] = raw ? body.type : 'application/json';
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? null : raw ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'server_unreachable',
      'Cannot reach the Friday server. Is it running?',
      true,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(
      res.status,
      'invalid_response',
      `Unexpected response from server (HTTP ${res.status}).`,
    );
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `HTTP ${res.status}`,
      err?.retryable ?? false,
    );
  }
  return data as T;
}

export const api = {
  settings: () => request<SettingsDto>('GET', '/api/settings'),
  setModel: (model: string) => request<{ model: string }>('PUT', '/api/settings/model', { model }),
  resetModel: () => request<unknown>('DELETE', '/api/settings/model'),
  models: (refresh = false) =>
    request<{ models: ModelInfo[] }>('GET', `/api/provider/models${refresh ? '?refresh=1' : ''}`),
  testConnection: (model?: string) =>
    request<ConnectionTestResult>('POST', '/api/provider/test', model ? { model } : {}),
  capabilities: () => request<ModelCapabilities>('GET', '/api/provider/capabilities'),
  probeCapabilities: () =>
    request<ModelCapabilities>('POST', '/api/provider/capabilities/probe', {}),
  setContextWindow: (tokens: number | null) =>
    request<ModelCapabilities>('PUT', '/api/provider/capabilities/context-window', { tokens }),
  providerCalls: () => request<{ calls: ProviderCallDto[] }>('GET', '/api/provider/calls'),

  system: () => request<SystemInfoDto>('GET', '/api/system'),
  projects: () => request<{ projects: ProjectDto[] }>('GET', '/api/projects'),
  addProject: (path: string, name?: string) =>
    request<ProjectDto>('POST', '/api/projects', name ? { path, name } : { path }),
  removeProject: (id: string) => request<void>('DELETE', `/api/projects/${id}`),
  projectSandbox: (id: string) => request<SandboxStatusDto>('GET', `/api/projects/${id}/sandbox`),
  setProjectSandbox: (id: string, settings: SandboxSettings) =>
    request<ProjectDto>('PUT', `/api/projects/${id}/sandbox`, settings),
  pullSandboxImage: (id: string, image: string) =>
    request<SandboxStatusDto>('POST', `/api/projects/${id}/sandbox/pull`, { image }),
  projectCodeMap: (id: string) => request<CodeMapStatusDto>('GET', `/api/projects/${id}/codemap`),
  rebuildCodeMap: (id: string) =>
    request<CodeMapStatusDto>('POST', `/api/projects/${id}/codemap/rebuild`),
  projectProcesses: (id: string) =>
    request<{ processes: ProcessDto[] }>('GET', `/api/projects/${id}/processes`),
  processOutput: (id: string, since?: number) =>
    request<ProcessOutputDto>(
      'GET',
      `/api/processes/${id}/output${since === undefined ? '' : `?since=${since}`}`,
    ),
  stopProcess: (id: string) => request<ProcessDto>('POST', `/api/processes/${id}/stop`),
  dismissProcess: (id: string) => request<void>('DELETE', `/api/processes/${id}`),
  projectOverview: (id: string) =>
    request<ProjectOverviewDto>('GET', `/api/projects/${id}/overview`),
  projectTree: (id: string, path = '.') =>
    request<{ path: string; entries: TreeEntryDto[]; truncated: boolean }>(
      'GET',
      `/api/projects/${id}/tree?path=${encodeURIComponent(path)}`,
    ),
  projectFile: (id: string, path: string) =>
    request<FileViewDto>('GET', `/api/projects/${id}/file?path=${encodeURIComponent(path)}`),

  /** projectId null lists conversations that have no project. */
  sessions: (projectId: string | null) =>
    request<{ sessions: SessionSummaryDto[] }>(
      'GET',
      `/api/sessions?project=${projectId ?? 'none'}`,
    ),
  createSession: (projectId: string | null) =>
    request<SessionSummaryDto>('POST', '/api/sessions', { projectId }),
  session: (id: string) => request<SessionDetailDto>('GET', `/api/sessions/${id}`),
  renameSession: (id: string, title: string) =>
    request<SessionSummaryDto>('PATCH', `/api/sessions/${id}`, { title }),
  deleteSession: (id: string) => request<void>('DELETE', `/api/sessions/${id}`),
  sendMessage: (id: string, content: string, attachmentIds: string[] = []) =>
    request<{ run: RunDto; userMessage: MessageDto }>('POST', `/api/sessions/${id}/messages`, {
      content,
      ...(attachmentIds.length ? { attachmentIds } : {}),
    }),
  uploadAttachment: (image: Blob, name: string) =>
    request<AttachmentDto>('POST', '/api/attachments', image, {
      'x-file-name': encodeURIComponent(name),
    }),
  removeAttachment: (id: string) => request<void>('DELETE', `/api/attachments/${id}`),
  decideApproval: (
    id: string,
    body: {
      decision: 'approve' | 'reject';
      actionHash: string;
      sessionId: string;
      note?: string;
      confirmation?: string;
      allowSimilar?: boolean;
    },
  ) => request<ApprovalDto>('POST', `/api/approvals/${id}/decision`, body),
  sessionChanges: (id: string) =>
    request<{ changes: FileChangeDto[] }>('GET', `/api/sessions/${id}/changes`),
  revertChange: (id: number) => request<FileChangeDto>('POST', `/api/file-changes/${id}/revert`),
  sshHosts: () => request<{ hosts: SshHostDto[] }>('GET', '/api/ssh-hosts'),
  addSshHost: (h: {
    name: string;
    hostname: string;
    port: number;
    username: string;
    identityFile: string | null;
    environment: HostEnvironment;
  }) => request<SshHostDto>('POST', '/api/ssh-hosts', h),
  removeSshHost: (id: string) => request<void>('DELETE', `/api/ssh-hosts/${id}`),
  scanSshHost: (id: string) =>
    request<{ keys: Array<{ fingerprint: string }> }>('POST', `/api/ssh-hosts/${id}/scan`),
  trustSshHost: (id: string, fingerprint: string) =>
    request<SshHostDto>('POST', `/api/ssh-hosts/${id}/trust`, { fingerprint }),
  untrustSshHost: (id: string) => request<SshHostDto>('POST', `/api/ssh-hosts/${id}/untrust`),
  testSshHost: (id: string) =>
    request<{ ok: boolean; message: string; detail?: string }>('POST', `/api/ssh-hosts/${id}/test`),
  logSources: () => request<{ sources: LogSourceDto[] }>('GET', '/api/log-sources'),
  addLogSource: (label: string, path: string) =>
    request<LogSourceDto>('POST', '/api/log-sources', { label, path }),
  removeLogSource: (id: string) => request<void>('DELETE', `/api/log-sources/${id}`),
  memories: (
    filter: { scope?: MemoryScope; projectId?: string | 'none'; status?: string; q?: string } = {},
  ) => {
    const params = new URLSearchParams(
      Object.entries(filter).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
      ),
    );
    return request<{ memories: MemoryDto[] }>(
      'GET',
      `/api/memories${params.size ? `?${params}` : ''}`,
    );
  },
  createMemory: (m: {
    scope: 'user' | 'project' | 'operational';
    category: MemoryCategory;
    content: string;
    projectId: string | null;
  }) => request<MemoryDto>('POST', '/api/memories', m),
  updateMemory: (
    id: string,
    changes: Partial<{
      content: string;
      category: MemoryCategory;
      pinned: boolean;
      confidence: 'confirmed' | 'assumed';
      status: 'active' | 'rejected';
    }>,
  ) => request<MemoryDto>('PATCH', `/api/memories/${id}`, changes),
  deleteMemory: (id: string) => request<void>('DELETE', `/api/memories/${id}`),
  memorySettings: () => request<MemorySettingsDto>('GET', '/api/memory/settings'),
  setMemorySettings: (s: MemorySettingsDto) =>
    request<MemorySettingsDto>('PUT', '/api/memory/settings', s),
  exportMemory: (projectId: string) =>
    request<{ path: string; count: number }>('POST', `/api/projects/${projectId}/memory/export`),
  rollbackRun: (runId: string) =>
    request<{ reverted: string[]; run: RunDto }>('POST', `/api/runs/${runId}/rollback`),
  retry: (id: string) => request<{ run: RunDto }>('POST', `/api/sessions/${id}/retry`),
  cancelRun: (runId: string) =>
    request<{ cancelled: boolean }>('POST', `/api/runs/${runId}/cancel`),
  revokeTaskPermission: (runId: string) =>
    request<{ revoked: boolean }>('POST', `/api/runs/${runId}/task-permission/revoke`),
};
