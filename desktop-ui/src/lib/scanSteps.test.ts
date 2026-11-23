import { describe, expect, it } from 'vitest';
import { STATE } from '../api/mockData';
import type { AgentView, AppState, PipelineStepView, PipelineView } from '../api/types';
import { estimateShown, scanStrip, stepLook } from './scanSteps';

const step = (patch: Partial<PipelineStepView>): PipelineStepView => ({ label: 'Home Depot part prices', state: 'now', figure: '', ...patch });

describe('a scan step', () => {
  it('has a mark for each of the five states, and a word for it', () => {
    const marks = (['done', 'now', 'next', 'skipped', 'failed'] as const).map((state) => stepLook(step({ state })));
    expect(marks.map((m) => m.mark)).toEqual(['done', 'running', 'waiting', 'skipped', 'failed']);
    expect(marks.map((m) => m.markWord)).toEqual(['Done', 'Running', 'Waiting', 'Skipped', 'Failed']);
  });
  it('says "N of M" when the step reports its own count, else the agent’s figure', () => {
    expect(stepLook(step({ done: 31, total: 40, figure: 'x' }))).toMatchObject({ count: '31 of 40', figure: '31 of 40' });
    expect(stepLook(step({ state: 'done', figure: '13 read' }))).toMatchObject({ count: null, figure: '13 read' });
    expect(stepLook(step({ done: 0, total: 0, figure: 'none' })).count).toBeNull();
  });
  it('says why a step was skipped or failed instead of a count', () => {
    expect(stepLook(step({ state: 'skipped', figure: 'key not accepted', done: 0, total: 5 }))).toMatchObject({ mark: 'skipped', figure: 'key not accepted' });
    expect(stepLook(step({ state: 'failed', figure: 'Anthropic did not answer' })).figure).toBe('Anthropic did not answer');
  });
  it('reads a state the agent never uses as waiting, not as done', () => {
    expect(stepLook(step({ state: 'mystery' as never })).mark).toBe('waiting');
  });
});

describe('the time figure', () => {
  const p = (estimateText: string): Pick<PipelineView, 'estimateText'> => ({ estimateText });
  it('shows only a rough figure the agent has', () => {
    expect(estimateShown(p('about 4 min'))).toBe('about 4 min');
    expect(estimateShown(p('under a minute'))).toBe('under a minute');
  });
  it('shows nothing for an empty text or a permanent "estimating"', () => {
    expect(estimateShown(p(''))).toBeNull();
    expect(estimateShown(p('  '))).toBeNull();
    expect(estimateShown(p('estimating'))).toBeNull();
    expect(estimateShown(null)).toBeNull();
  });
});

describe('the line above a list while a scan runs', () => {
  const pipeline: PipelineView = { current: { label: 'Reading part prices', count: '31 of 40' }, estimateText: '', stepsDone: 2, stepsTotal: 8, fraction: 0.4, ariaValueText: '', steps: [] };
  const agent = (patch: Partial<AgentView>): Pick<AgentView, 'status' | 'pipeline'> => ({ ...(STATE as AppState).agent, status: 'scanning', pipeline, ...patch });
  it('names the step, its count and the stage', () => {
    expect(scanStrip(agent({}))).toBe('Scanning · step 3 of 8 · Reading part prices 31 of 40');
  });
  it('leaves out the count when the step has none, and never counts past the last step', () => {
    expect(scanStrip(agent({ pipeline: { ...pipeline, current: { label: 'Finishing up', count: '' }, stepsDone: 8 } }))).toBe('Scanning · step 8 of 8 · Finishing up');
  });
  it('is nothing while idle, asking the AI or without stages', () => {
    expect(scanStrip(agent({ status: 'idle' }))).toBeNull();
    expect(scanStrip(agent({ status: 'asking' }))).toBeNull();
    expect(scanStrip(agent({ pipeline: null }))).toBeNull();
  });
});
