import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderTaskSummary } from '../providers/taskStore';
import {
  calculateTaskAssignmentProgress,
  createTaskAssignment,
  createTaskAssignments,
  createTaskAssignmentsForPids,
  deleteTaskAssignment,
  listTaskAssignments,
  updateTaskAssignment,
  updateTaskAssignmentFeedback,
  type TaskAssignment,
} from './taskAssignments';

const originalRoot = process.env.WORKSPACE_DATA_ROOT;
const testRoot = path.join('D:\\all_projects\\workspace\\data', `task-assignment-test-${process.pid}`);

describe('task assignments', () => {
  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    process.env.WORKSPACE_DATA_ROOT = testRoot;
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (originalRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT;
    else process.env.WORKSPACE_DATA_ROOT = originalRoot;
  });

  it('persists validated assignments and refreshes the operator name', () => {
    const created = createTaskAssignment({ pid: '1732365706607232663', urgent: true, operatorId: 'operator-wufengyan', quantity: 20 });
    expect(created).toMatchObject({ pid: '1732365706607232663', source: 'tap', urgent: true, operatorName: '吴凤燕', quantity: 20, feedback: '' });
    expect(listTaskAssignments()).toHaveLength(1);

    const updated = updateTaskAssignment(created.id, { pid: '1732365706607232663', urgent: false, operatorId: 'operator-chenxi', quantity: 12 });
    expect(updated).toMatchObject({ operatorName: '陈曦', quantity: 12, urgent: false });
    expect(deleteTaskAssignment(created.id)).toBe(true);
    expect(listTaskAssignments()).toEqual([]);
  });

  it('treats stored assignments created before urgent support as normal tasks', () => {
    const file = path.join(testRoot, 'workspace', 'task-assignments.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([{
      id: 'assignment-old',
      pid: '1731',
      source: 'tap',
      operatorId: 'operator-wufengyan',
      operatorName: '吴凤燕',
      quantity: 2,
      feedback: '',
      createdAt: '2026-09-28T02:00:00.000Z',
      updatedAt: '2026-09-28T02:00:00.000Z',
    }]));

    expect(listTaskAssignments()).toEqual([expect.objectContaining({ id: 'assignment-old', urgent: false })]);
  });

  it('lets an operator update feedback only on their own assignment', () => {
    const created = createTaskAssignment({ pid: '1731', operatorId: 'operator-wufengyan', quantity: 3 });
    expect(updateTaskAssignmentFeedback(created.id, 'operator-wufengyan', '成片动作需要更自然')).toMatchObject({ feedback: '成片动作需要更自然' });
    expect(() => updateTaskAssignmentFeedback(created.id, 'operator-chenxi', '越权修改')).toThrow('forbidden');
    expect(updateTaskAssignmentFeedback(created.id, undefined, '')).toMatchObject({ feedback: '' });
    expect(() => updateTaskAssignmentFeedback(created.id, 'operator-wufengyan', 'x'.repeat(2_001))).toThrow('invalid_feedback');
  });

  it('rejects unknown operators and invalid quantities', () => {
    expect(() => createTaskAssignment({ pid: '1731', operatorId: 'unknown', quantity: 10 })).toThrow('operator_not_found');
    expect(() => createTaskAssignment({ pid: '1731', operatorId: 'operator-wufengyan', quantity: 0 })).toThrow('invalid_quantity');
  });

  it('creates one TAP/CAP batch atomically for multiple operators', () => {
    const created = createTaskAssignments([
      { pid: '1731', source: 'cap', urgent: true, operatorId: 'operator-guoqingqing', quantity: 3 },
      { pid: '1731', source: 'cap', urgent: true, operatorId: 'operator-chenxi', quantity: 4 },
    ]);
    expect(created).toHaveLength(2);
    expect(created.every((item) => item.pid === '1731' && item.source === 'cap' && item.urgent)).toBe(true);
    expect(listTaskAssignments()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operatorName: '郭青青', quantity: 3 }),
      expect.objectContaining({ operatorName: '陈曦', quantity: 4 }),
    ]));
    expect(() => createTaskAssignments([
      { pid: '1732', source: 'tap', operatorId: 'operator-chenxi', quantity: 1 },
      { pid: '1732', source: 'tap', operatorId: 'operator-chenxi', quantity: 2 },
    ])).toThrow('duplicate_operator');
  });

  it('creates the same operator allocation for new PIDs and skips existing and duplicate PIDs', () => {
    createTaskAssignment({ pid: '1731', source: 'tap', operatorId: 'operator-wufengyan', quantity: 1 });
    const result = createTaskAssignmentsForPids(
      ['1731', '1732', '1732', '1733'],
      'cap',
      [
        { operatorId: 'operator-guoqingqing', quantity: 3 },
        { operatorId: 'operator-chenxi', quantity: 4 },
      ],
      true,
    );

    expect(result.createdPids).toEqual(['1732', '1733']);
    expect(result.skippedPids).toEqual(['1731']);
    expect(result.created).toHaveLength(4);
    expect(result.created.every((item) => item.source === 'cap' && item.urgent)).toBe(true);
    expect(listTaskAssignments()).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: '1732', operatorName: '郭青青', quantity: 3 }),
      expect.objectContaining({ pid: '1732', operatorName: '陈曦', quantity: 4 }),
      expect.objectContaining({ pid: '1733', operatorName: '郭青青', quantity: 3 }),
      expect.objectContaining({ pid: '1733', operatorName: '陈曦', quantity: 4 }),
    ]));
  });

  it('validates a multi-PID assignment before writing anything', () => {
    expect(() => createTaskAssignmentsForPids(
      ['1732', 'bad pid'],
      'tap',
      [{ operatorId: 'operator-chenxi', quantity: 2 }],
    )).toThrow('invalid_pid');
    expect(listTaskAssignments()).toEqual([]);
    expect(() => createTaskAssignmentsForPids(
      ['1732'],
      'tap',
      [{ operatorId: 'operator-chenxi', quantity: 0 }],
    )).toThrow('invalid_quantity');
    expect(listTaskAssignments()).toEqual([]);
  });

  it('lists only assignments belonging to the requested operator', () => {
    createTaskAssignment({ pid: '1731', operatorId: 'operator-wufengyan', quantity: 3 });
    createTaskAssignment({ pid: '1732', operatorId: 'operator-chenxi', quantity: 4 });

    expect(listTaskAssignments('operator-wufengyan')).toEqual([
      expect.objectContaining({ pid: '1731', operatorId: 'operator-wufengyan', quantity: 3 }),
    ]);
  });

  it('counts only matching inventory-saved video tasks after each assignment was created', () => {
    const assignment = (overrides: Partial<TaskAssignment> = {}): TaskAssignment => ({
      id: 'assignment-one',
      pid: '1731',
      source: 'tap',
      urgent: false,
      operatorId: 'operator-wufengyan',
      operatorName: '吴凤燕',
      quantity: 5,
      feedback: '',
      createdAt: '2026-09-28T02:00:00.000Z',
      updatedAt: '2026-09-28T02:00:00.000Z',
      ...overrides,
    });
    const task = (id: string, taskName: string, inventorySavedAt: string, ownerId = 'operator-wufengyan'): ProviderTaskSummary => ({
      id,
      accountId: 'workspace-account-3-a',
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-imagine-video-1.5',
      status: 'completed',
      progress: 100,
      outputCount: 1,
      inventorySavedAt,
      createdAt: '2026-09-28T01:00:00.000Z',
      updatedAt: inventorySavedAt,
      metadata: { ownerId, taskNameMode: 'manual', taskName, taskNameSequence: 1 },
    });
    const assignments = [
      assignment(),
      assignment({ id: 'assignment-later', quantity: 1, createdAt: '2026-09-28T03:30:00.000Z' }),
    ];
    const tasks = [
      task('underscore', '1731_look', '2026-09-28T03:00:00.000Z'),
      task('hyphen', '1731-look', '2026-09-28T04:00:00.000Z'),
      task('longer-pid', '17310_look', '2026-09-28T04:00:00.000Z'),
      task('other-owner', '1731_look', '2026-09-28T04:00:00.000Z', 'operator-chenxi'),
      task('too-early', '1731_look', '2026-09-28T01:59:59.000Z'),
    ];

    expect(calculateTaskAssignmentProgress(assignments, tasks)).toEqual([
      expect.objectContaining({ id: 'assignment-one', completedQuantity: 2, pendingQuantity: 3 }),
      expect.objectContaining({ id: 'assignment-later', completedQuantity: 1, pendingQuantity: 0 }),
    ]);
  });

  it('falls back to the account owner and never returns a negative pending quantity', () => {
    const assignment: TaskAssignment = {
      id: 'assignment-one', pid: '1731', source: 'tap', urgent: false, operatorId: 'operator-wufengyan', operatorName: '吴凤燕', quantity: 1,
      feedback: '',
      createdAt: '2026-09-28T02:00:00.000Z', updatedAt: '2026-09-28T02:00:00.000Z',
    };
    const tasks: ProviderTaskSummary[] = ['first', 'second'].map((id, index) => ({
      id,
      accountId: 'workspace-account-3-a',
      mode: 'video',
      provider: 'grok-video',
      status: 'completed',
      progress: 100,
      outputCount: 1,
      inventorySavedAt: `2026-09-28T0${index + 3}:00:00.000Z`,
      createdAt: '2026-09-28T02:00:00.000Z',
      updatedAt: '2026-09-28T04:00:00.000Z',
      metadata: { taskNameMode: 'manual', taskName: '1731_showcase' },
    }));

    expect(calculateTaskAssignmentProgress([assignment], tasks)[0]).toMatchObject({ completedQuantity: 2, pendingQuantity: 0 });
  });
});
