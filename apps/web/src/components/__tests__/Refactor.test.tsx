import type { ApprovalDto, RefactorInfo } from '@friday/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../ApprovalCard';
import { toolLabel } from '../ToolActivity';

afterEach(cleanup);

const approval = (refactor: RefactorInfo): ApprovalDto => ({
  id: 'a',
  sessionId: 's',
  runId: 'r',
  projectId: 'p1',
  toolCallId: 'c',
  toolName: refactor.kind === 'rename' ? 'rename_symbol' : 'move_symbol',
  category: 'file_modify',
  risk: 'medium',
  title:
    refactor.kind === 'rename'
      ? 'Rename cartTotal to computeTotal'
      : 'Move cartTotal to src/pricing.ts',
  summary: 'Changes 7 occurrences in 4 files as one step.',
  reason: 'clearer name',
  details: {
    kind: 'file_change',
    changes: [
      {
        path: 'src/api.ts',
        change: 'modify',
        diff: "--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1,1 +1,1 @@\n-import { cartTotal } from './index';\n+import { computeTotal } from './index';\n",
        added: 1,
        removed: 1,
      },
    ],
    refactor,
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

describe('refactor approvals', () => {
  it('shows a rename with what it leaves alone, and the matches the model added', () => {
    render(
      <ApprovalCard
        approval={approval({
          kind: 'rename',
          symbol: 'cartTotal',
          definition: 'src/cart.ts:7',
          target: 'computeTotal',
          changed: 8,
          notChanged: [
            {
              path: 'src/legacy.js',
              line: 1,
              text: 'function cartTotal(x) {',
              reason: "this file doesn't import it from src/cart.ts",
            },
          ],
          included: [
            {
              path: 'src/checkout.ts',
              line: 3,
              text: '// cartTotal includes tax',
              reason: 'in a comment',
            },
          ],
          notes: [],
        })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(/8 occurrences Friday tied to the definition/)).toBeTruthy();
    const left = screen.getByRole('region', { name: 'Left unchanged: may be a different symbol' });
    expect(within(left).getByText('src/legacy.js:1')).toBeTruthy();
    expect(within(left).getByText("this file doesn't import it from src/cart.ts")).toBeTruthy();
    const also = screen.getByRole('region', {
      name: 'Also changed: uncertain matches the model checked',
    });
    expect(within(also).getByText('// cartTotal includes tax')).toBeTruthy();
    expect(screen.getByText('src/api.ts')).toBeTruthy();
  });

  it('shows a move with its notes and the uses to fix by hand', () => {
    render(
      <ApprovalCard
        approval={approval({
          kind: 'move',
          symbol: 'cartTotal',
          definition: 'src/cart.ts:7',
          target: 'src/pricing.ts',
          changed: 2,
          notChanged: [
            {
              path: 'src/report.ts',
              line: 1,
              text: "import * as cart from './cart';",
              reason: 'uses cartTotal through a namespace import of src/cart.ts',
            },
          ],
          included: [],
          notes: ['TAX is now exported from src/cart.ts, because cartTotal uses it.'],
        })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(/updating 2 imports/)).toBeTruthy();
    expect(
      screen.getByText('TAX is now exported from src/cart.ts, because cartTotal uses it.'),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Not updated: check these by hand' })).toBeTruthy();
  });

  it('labels the tool calls', () => {
    expect(
      toolLabel('rename_symbol', JSON.stringify({ symbol: 'Cart.total', new_name: 'subtotal' })),
    ).toBe('Cart.total → subtotal');
    expect(
      toolLabel('move_symbol', JSON.stringify({ symbol: 'cartTotal', to: 'src/pricing.ts' })),
    ).toBe('cartTotal → src/pricing.ts');
    expect(
      toolLabel('find_references', JSON.stringify({ symbol: 'cartTotal', path: 'src/cart.ts' })),
    ).toBe('cartTotal in src/cart.ts');
  });
});
