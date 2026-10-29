import type {
  ApiErrorBody,
  ApprovalDto,
  FileChangeDto,
  ConnectionTestResult,
  FileViewDto,
  ProjectDto,
  ProjectOverviewDto,
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

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  // Required by the server's CSRF guard on mutating requests.
  if (method !== 'GET') headers['x-friday-client'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
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
  sendMessage: (id: string, content: string) =>
    request<{ run: RunDto; userMessage: MessageDto }>('POST', `/api/sessions/${id}/messages`, {
      content,
    }),
  decideApproval: (
    id: string,
    body: { decision: 'approve' | 'reject'; actionHash: string; sessionId: string; note?: string },
  ) => request<ApprovalDto>('POST', `/api/approvals/${id}/decision`, body),
  sessionChanges: (id: string) =>
    request<{ changes: FileChangeDto[] }>('GET', `/api/sessions/${id}/changes`),
  revertChange: (id: number) => request<FileChangeDto>('POST', `/api/file-changes/${id}/revert`),
  rollbackRun: (runId: string) =>
    request<{ reverted: string[]; run: RunDto }>('POST', `/api/runs/${runId}/rollback`),
  retry: (id: string) => request<{ run: RunDto }>('POST', `/api/sessions/${id}/retry`),
  cancelRun: (runId: string) =>
    request<{ cancelled: boolean }>('POST', `/api/runs/${runId}/cancel`),
};
