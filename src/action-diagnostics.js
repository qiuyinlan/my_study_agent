import { getMeta } from './db.js';
import { nowISO } from './util.js';

export async function buildActionDiagnosticsExport({ limit = 300 } = {}) {
  const [rawActions, rawTurns] = await Promise.all([
    getMeta('actionLedger', []),
    getMeta('actionTurnEvents', []),
  ]);
  const actions = Array.isArray(rawActions) ? rawActions.slice(-limit) : [];
  const turns = Array.isArray(rawTurns) ? rawTurns.slice(-limit) : [];
  return {
    schema: 1,
    exportedAt: nowISO(),
    privacy: 'No user text, assistant text, argument values, session IDs, turn IDs, operation IDs or entity IDs.',
    actions: actions.map(item => ({
      kind: item.kind,
      status: item.status,
      parameterNames: Object.keys(item.args || {}).sort(),
      missingFields: item.missingFields || [],
      requiresConfirmation: Boolean(item.requiresConfirmation),
      errorCode: item.result?.errorCode || '',
      retryable: Boolean(item.result?.retryable),
      idempotencyKeyPresent: Boolean(item.idempotencyKey),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    turns: turns.map(item => ({
      toolCallCount: item.toolCallCount,
      holdWriteReply: Boolean(item.holdWriteReply),
      finalReplyLength: String(item.finalContent || '').length,
      actionStatuses: (item.actionStatuses || []).map(action => ({
        kind: action.kind,
        status: action.status,
        errorCode: action.errorCode || '',
      })),
      createdAt: item.createdAt,
    })),
  };
}
