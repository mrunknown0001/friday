import type { ApprovalDto, MessageDto, SessionDetailDto, VoiceStatusDto } from '@friday/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import * as voice from '../../lib/voice';
import { ChatView } from '../ChatView';
import { VoiceControls } from '../VoiceControls';
import { VoiceSettings } from '../VoiceSettings';

const model = (
  id: 'speech' | 'transcription',
  state: VoiceStatusDto['models'][number]['state'],
): VoiceStatusDto['models'][number] => ({
  id,
  label: id === 'speech' ? 'Kokoro 82M (8-bit)' : 'Whisper base (8-bit)',
  repo: id === 'speech' ? 'onnx-community/Kokoro-82M-v1.0-ONNX' : 'onnx-community/whisper-base',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  url: 'https://huggingface.co/x',
  license: 'Apache-2.0',
  sizeBytes: id === 'speech' ? 92_368_770 : 79_663_997,
  state,
  receivedBytes: state === 'downloading' ? 46_000_000 : 0,
  error: null,
});

const status = (speech: string, transcription: string): VoiceStatusDto => ({
  installed: true,
  models: [model('speech', speech as never), model('transcription', transcription as never)],
  voices: [
    { id: 'af_heart', name: 'Heart', accent: 'American', gender: 'female' },
    { id: 'bm_george', name: 'George', accent: 'British', gender: 'male' },
  ],
  settings: { voice: 'af_heart', speed: 1, language: 'english' },
});

async function withStatus(s: VoiceStatusDto) {
  vi.spyOn(api, 'voice').mockResolvedValue(s);
  await act(async () => {
    await voice.refreshVoiceStatus();
  });
}

beforeEach(() => {
  voice.setSpeakReplies(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('voice settings', () => {
  it('downloads a model only on request and shows progress', async () => {
    await withStatus(status('missing', 'downloading'));
    const download = vi.spyOn(api, 'downloadVoiceModel').mockResolvedValue({} as never);
    render(<VoiceSettings />);
    const speech = screen.getByRole('listitem', { name: 'Kokoro 82M (8-bit): missing' });
    expect(within(speech).getByText(/onnx-community\/Kokoro-82M-v1.0-ONNX/)).toBeTruthy();
    expect(within(speech).getByText('1939ad2a8e')).toBeTruthy();
    fireEvent.click(within(speech).getByRole('button', { name: 'Download 92 MB' }));
    await waitFor(() => expect(download).toHaveBeenCalledWith('speech'));
    const bar = screen.getByRole('progressbar', { name: 'Downloading Whisper base (8-bit)' });
    expect(bar.getAttribute('aria-valuenow')).toBe('57');
  });

  it('saves the chosen voice', async () => {
    await withStatus(status('ready', 'ready'));
    const save = vi.spyOn(api, 'setVoiceSettings').mockResolvedValue({} as never);
    render(<VoiceSettings />);
    fireEvent.change(screen.getByLabelText('Speaking voice'), { target: { value: 'bm_george' } });
    expect(save).toHaveBeenCalledWith({ voice: 'bm_george', speed: 1, language: 'english' });
    expect(screen.getByRole('button', { name: /Try the voice/ })).toBeTruthy();
  });
});

describe('composer voice controls', () => {
  it('points to Settings when a model is missing', async () => {
    await withStatus(status('missing', 'missing'));
    const open = vi.fn();
    render(<VoiceControls onTranscript={vi.fn()} onOpenSettings={open} />);
    fireEvent.click(screen.getByRole('button', { name: 'Speak replies' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Spoken replies need the speech model. Download it in Settings → Voice.',
    );
    expect(screen.getByRole('button', { name: 'Speak replies' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(open).toHaveBeenCalled();
  });

  it('records only while the microphone is on, then puts the transcript in the box', async () => {
    await withStatus(status('ready', 'ready'));
    vi.stubGlobal('MediaRecorder', class {});
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    const wav = new Blob(['RIFF'], { type: 'audio/wav' });
    const stop = vi.fn().mockResolvedValue(wav);
    vi.spyOn(voice.recorder, 'start').mockResolvedValue({
      level: () => 0.5,
      stop,
      cancel: vi.fn(),
    });
    const transcribe = vi.spyOn(api, 'transcribe').mockResolvedValue({ text: 'run the tests' });
    const onTranscript = vi.fn();
    render(<VoiceControls onTranscript={onTranscript} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/^Listening · 0:0\d$/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('run the tests'));
    expect(stop).toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledWith(wav);
    expect(screen.queryByText(/Listening/)).toBeNull();
    vi.unstubAllGlobals();
  });
});

const msg = (
  id: number,
  role: 'user' | 'assistant',
  content: string,
  runId: string | null,
): MessageDto => ({
  id,
  sessionId: 's1',
  runId,
  role,
  content,
  status: 'complete',
  model: role === 'assistant' ? 'test-model' : null,
  createdAt: '2026-10-31T10:00:00.000Z',
});

const detail = (messages: MessageDto[]): SessionDetailDto => ({
  id: 's1',
  projectId: null,
  title: 'Chat',
  createdAt: '2026-10-31T10:00:00.000Z',
  updatedAt: '2026-10-31T10:00:00.000Z',
  lastRunStatus: null,
  messages,
  latestRun: null,
  hasSummary: false,
  plan: null,
  approvals: [],
  runs: [],
  deploymentPlans: [],
  reviews: [],
  testRuns: [],
  browserFlows: [],
  loadTests: [],
  research: [],
  memoryUsage: {},
});

describe('spoken replies in the conversation', () => {
  it('puts one play button under each reply', async () => {
    await withStatus(status('ready', 'missing'));
    const play = vi.spyOn(voice.player, 'playRun').mockResolvedValue();
    render(
      <ChatView
        detail={detail([
          msg(1, 'user', 'fix it', 'r1'),
          msg(2, 'assistant', 'Looking at the tests.', 'r1'),
          msg(3, 'assistant', 'Fixed: the last item is counted now.', 'r1'),
        ])}
        project={null}
        live={null}
        canSend
        blockedReason={null}
        sidePanelOpen={false}
        onToggleSidePanel={() => {}}
        onSend={async () => true}
        onStop={() => {}}
        onRetry={() => {}}
        onOpenSettings={() => {}}
        approvals={[]}
        onDecide={async () => {}}
        deploymentPlans={[]}
        onRollback={async () => {}}
        onOpenMemory={() => {}}
        onRevokeTaskPermission={async () => {}}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: 'Play reply aloud' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(play).toHaveBeenCalledWith('s1', 'r1');
  });

  it('announces a new approval card once, but not one already there', async () => {
    await withStatus(status('ready', 'missing'));
    voice.setSpeakReplies(true);
    const say = vi.spyOn(voice.player, 'say').mockResolvedValue();
    const approval = (id: string, category: ApprovalDto['category']): ApprovalDto => ({
      id,
      sessionId: 's1',
      runId: 'r1',
      projectId: null,
      toolCallId: id,
      toolName: 'run_load_test',
      category,
      risk: 'medium',
      title: 'Run npm test',
      summary: 'npm test',
      reason: 'check the build',
      details: {
        kind: 'load_test',
        target: { name: null, origin: 'http://localhost:5199', environment: 'local' },
        vus: 1,
        stages: null,
        durationSeconds: 10,
        thinkTimeMs: 0,
        requests: [],
        thresholds: [],
        script: '',
        k6: 'k6',
        limits: { maxVus: 100, maxDurationSeconds: 600 },
        riskReasons: [],
      },
      actionHash: 'f'.repeat(64),
      status: 'pending',
      decisionNote: null,
      resultSummary: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      decidedAt: null,
      confirmationRequired: null,
      grantedBy: null,
    });
    const view = (approvals: ApprovalDto[]) => (
      <ChatView
        detail={detail([msg(1, 'user', 'deploy', 'r1')])}
        project={null}
        live={null}
        canSend
        blockedReason={null}
        sidePanelOpen={false}
        onToggleSidePanel={() => {}}
        onSend={async () => true}
        onStop={() => {}}
        onRetry={() => {}}
        onOpenSettings={() => {}}
        approvals={approvals}
        onDecide={async () => {}}
        deploymentPlans={[]}
        onRollback={async () => {}}
        onOpenMemory={() => {}}
        onRevokeTaskPermission={async () => {}}
      />
    );
    const old = approval('a0', 'git');
    const { rerender } = render(view([old]));
    expect(say).not.toHaveBeenCalled();
    rerender(view([old, approval('a1', 'shell')]));
    rerender(view([old, approval('a1', 'shell')]));
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith(
      'approval:a1',
      'Friday needs your approval to run a command. The card is in the conversation.',
    );
  });

  it('announces an approval without reading what is on the card', () => {
    expect(voice.approvalAnnouncement('shell')).toBe(
      'Friday needs your approval to run a command. The card is in the conversation.',
    );
  });
});
