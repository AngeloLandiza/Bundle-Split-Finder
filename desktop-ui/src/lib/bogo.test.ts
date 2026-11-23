import { describe, expect, it } from 'vitest';
import { MOCK_ELIGIBLE } from '../api/mockTracking';
import { bogoMenuLabel, pickedTools, typedTool } from './bogo';

describe('a free tool he typed', () => {
  it('sends the model in capitals with the title and link he gave, and nothing he left empty', () => {
    expect(typedTool({ model: ' dcf887b ', title: '', link: '' })).toEqual({ ok: true, body: { chosen: [{ model: 'DCF887B' }] } });
    expect(typedTool({ model: 'DCF887B', title: 'Impact driver (Tool Only)', link: 'https://www.homedepot.com/s/DCF887B' })).toEqual({
      ok: true,
      body: { chosen: [{ model: 'DCF887B', title: 'Impact driver (Tool Only)', link: 'https://www.homedepot.com/s/DCF887B' }] },
    });
  });
  it('asks for a model number, and for a link that is a web address', () => {
    expect(typedTool({ model: '', title: '', link: '' })).toEqual({ ok: false, problem: 'Enter the free tool’s model number, such as DCF887B.' });
    expect(typedTool({ model: 'two words', title: '', link: '' }).ok).toBe(false);
    expect(typedTool({ model: 'DCF887B', title: '', link: 'homedepot.com/s/DCF887B' })).toEqual({ ok: false, problem: 'The link must start with http or https.' });
  });
});

describe('free tools picked from the eligible list', () => {
  it('sends the items as the list gave them, so the agent finds them on its eligible list', () => {
    const r = pickedTools(MOCK_ELIGIBLE, ['DCS391B'], 1);
    expect(r).toMatchObject({ ok: true, body: { chosen: [{ brand: 'DEWALT', model: 'DCS391B', link: 'https://www.homedepot.com/s/DCS391B' }] } });
  });
  it('refuses none, and more than the promotion gives', () => {
    expect(pickedTools(MOCK_ELIGIBLE, [], 1)).toEqual({ ok: false, problem: 'Choose the free tool.' });
    expect(pickedTools(MOCK_ELIGIBLE, ['DCS391B', 'DCG413B'], 1)).toEqual({ ok: false, problem: 'This promotion gives 1 free tool. Untick one.' });
    expect(pickedTools(MOCK_ELIGIBLE, ['DCS391B', 'DCG413B'], 2).ok).toBe(true);
  });
  it('ignores a model the list does not hold', () => {
    expect(pickedTools(MOCK_ELIGIBLE, ['XYZ'], 1).ok).toBe(false);
  });
});

describe('the menu words', () => {
  it('follow the promotion\'s state', () => {
    expect(bogoMenuLabel(null)).toBe('Mark as BOGO…');
    expect(bogoMenuLabel('choose')).toBe('Choose the free tool…');
    expect(bogoMenuLabel('chosen')).toBe('Change the free tool…');
  });
});
