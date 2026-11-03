import type { SettingsDto } from '@friday/shared';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import { SettingsDialog } from '../SettingsDialog';

// The other Settings sections load their own data and have their own tests.
vi.mock('../DatabaseSettings', () => ({ DatabaseSettings: () => null }));
vi.mock('../DevopsSettings', () => ({ DevopsSettings: () => null }));
vi.mock('../LoadTargetSettings', () => ({ LoadTargetSettings: () => null }));
vi.mock('../VoiceSettings', () => ({ VoiceSettings: () => null }));
vi.mock('../WebSettings', () => ({ WebSettings: () => null }));
vi.mock('../McpSettings', () => ({ McpSettings: () => null }));
vi.mock('../UsageSettings', () => ({ UsageSettings: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(api, 'capabilities').mockRejectedValue(
    new ApiError(400, 'model_not_selected', 'Select a model in Settings first.'),
  );
  vi.spyOn(api, 'providerCalls').mockResolvedValue({ calls: [] });
});

const settings: SettingsDto = {
  model: 'anthropic:claude-sonnet-4-6',
  modelSource: 'settings',
  apiKeyConfigured: true,
  providers: [
    {
      id: 'notokenlimit',
      label: 'NoTokenLimit',
      configured: true,
      envVar: 'NTL_API_KEY',
      baseUrl: 'https://notokenlimit.com/api/v1',
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      configured: true,
      envVar: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://api.anthropic.com',
    },
    {
      id: 'openai',
      label: 'OpenAI',
      configured: false,
      envVar: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      configured: true,
      envVar: 'OPENROUTER_API_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
    },
  ],
  envFile: '/home/me/friday/.env',
  baseUrl: 'https://notokenlimit.com/api/v1',
  timeoutMs: 120_000,
  maxRetries: 2,
};

describe('model providers in Settings', () => {
  it('shows which providers have a key, and lists models grouped by provider', async () => {
    vi.spyOn(api, 'models').mockResolvedValue({
      models: [
        { id: 'anthropic:claude-sonnet-4-6', provider: 'anthropic', name: 'Claude Sonnet 4.6' },
        { id: 'claude-opus-5.5', provider: 'notokenlimit' },
      ],
      errors: [{ provider: 'openrouter', message: 'OpenRouter rejected the API key.' }],
    });
    await act(async () => {
      render(
        <SettingsDialog onClose={() => {}} settings={settings} onSettingsChanged={() => {}} />,
      );
    });

    const list = screen.getByRole('list', { name: 'Model providers' });
    const rows = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(rows[0]).toContain('NoTokenLimitkey setNTL_API_KEY');
    expect(rows[2]).toContain('OpenAInot setOPENAI_API_KEY');
    expect(list.textContent).not.toMatch(/sk-|ntl-/);

    const picker = screen.getByRole('listbox', { name: 'Model' });
    const groups = [...picker.querySelectorAll('optgroup')].map((g) => [
      g.label,
      [...g.querySelectorAll('option')].map((o) => `${o.value} = ${o.textContent}`),
    ]);
    // In the order Settings lists the providers; other providers' ids are shown without prefix.
    expect(groups).toEqual([
      ['NoTokenLimit', ['claude-opus-5.5 = claude-opus-5.5']],
      ['Anthropic', ['anthropic:claude-sonnet-4-6 = claude-sonnet-4-6 — Claude Sonnet 4.6']],
    ]);
    expect((picker as HTMLSelectElement).value).toBe('anthropic:claude-sonnet-4-6');
    expect(screen.getByText(/2 models from NoTokenLimit, Anthropic\./)).toBeTruthy();
    expect(screen.getByText('OpenRouter: OpenRouter rejected the API key.')).toBeTruthy();
  });

  it('explains how to add a key when none is set', async () => {
    const none: SettingsDto = {
      ...settings,
      model: null,
      modelSource: 'none',
      apiKeyConfigured: false,
      providers: settings.providers.map((p) => ({ ...p, configured: false })),
    };
    const models = vi.spyOn(api, 'models');
    await act(async () => {
      render(<SettingsDialog onClose={() => {}} settings={none} onSettingsChanged={() => {}} />);
    });
    expect(screen.getByText(/No provider is configured yet\./)).toBeTruthy();
    expect(screen.getByText(/Add a provider.s API key to load its models\./)).toBeTruthy();
    expect(models).not.toHaveBeenCalled();
  });
});
