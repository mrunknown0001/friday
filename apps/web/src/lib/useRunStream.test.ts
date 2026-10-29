import type { ApprovalDto } from '@friday/shared';
import { describe, expect, it } from 'vitest';
import { applyEvent, initial } from './useRunStream';

describe('applyEvent', () => {
  it('interleaves text and tools, streams command output, and tracks approvals', () => {
    let s = initial('r1');
    s = applyEvent(s, { seq: 1, type: 'text_delta', delta: 'Running ' });
    s = applyEvent(s, { seq: 2, type: 'text_delta', delta: 'tests.' });
    s = applyEvent(s, {
      seq: 3,
      type: 'tool_started',
      callId: 'c1',
      name: 'run_command',
      arguments: '{"argv":["npm","test"]}',
    });
    const approval = { id: 'a1', toolCallId: 'c1', status: 'pending' } as ApprovalDto;
    s = applyEvent(s, { seq: 4, type: 'approval_requested', approval });
    s = applyEvent(s, {
      seq: 5,
      type: 'approval_resolved',
      approval: { ...approval, status: 'approved' },
    });
    s = applyEvent(s, { seq: 6, type: 'command_output', callId: 'c1', chunk: 'PASS ' });
    s = applyEvent(s, { seq: 7, type: 'command_output', callId: 'c1', chunk: 'all' });
    s = applyEvent(s, {
      seq: 8,
      type: 'tool_finished',
      callId: 'c1',
      name: 'run_command',
      status: 'completed',
      summary: 'exit code 0',
      durationMs: 900,
    });
    s = applyEvent(s, { seq: 9, type: 'text_delta', delta: 'Done.' });

    expect(s.blocks).toEqual([
      { kind: 'text', text: 'Running tests.' },
      {
        kind: 'tool',
        callId: 'c1',
        name: 'run_command',
        arguments: '{"argv":["npm","test"]}',
        status: 'completed',
        summary: 'exit code 0',
        durationMs: 900,
        output: 'PASS all',
      },
      { kind: 'text', text: 'Done.' },
    ]);
    expect(s.approvals.a1?.status).toBe('approved');
  });
});
