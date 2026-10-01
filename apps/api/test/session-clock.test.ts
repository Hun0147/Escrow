import { realtime } from '../src/realtime/bus';
import {
  clearSessions,
  closeSession,
  sessionMinutes,
  startSessionClock,
} from '../src/realtime/session-clock';

/** Collects everything published to the realtime bus during a test. */
function capture() {
  const messages: { event: string; payload: unknown; scope: unknown }[] = [];
  const listener = (message: any) => messages.push(message);
  realtime.on('message', listener);
  return {
    messages,
    stop: () => realtime.off('message', listener),
  };
}

const USER = '11111111-2222-3333-4444-555555555555';

describe('session-time reminders', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
    jest.useRealTimers();
  });

  it('nudges a player at the interval they chose', () => {
    const recorder = capture();
    startSessionClock(USER, 30);
    jest.advanceTimersByTime(30 * 60_000);

    const reminders = recorder.messages.filter((m) => m.event === 'session:reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0].payload).toMatchObject({ intervalMinutes: 30, elapsedMinutes: 30 });
    recorder.stop();
  });

  it('keeps nudging on every subsequent interval', () => {
    const recorder = capture();
    startSessionClock(USER, 15);
    jest.advanceTimersByTime(45 * 60_000);

    expect(recorder.messages.filter((m) => m.event === 'session:reminder')).toHaveLength(3);
    recorder.stop();
  });

  it('says nothing to a player who has not asked for reminders', () => {
    const recorder = capture();
    startSessionClock(USER, null);
    jest.advanceTimersByTime(4 * 60 * 60_000);

    expect(recorder.messages.filter((m) => m.event === 'session:reminder')).toHaveLength(0);
    recorder.stop();
  });

  it('counts one session across several tabs, not one per connection', () => {
    const recorder = capture();
    startSessionClock(USER, 20);
    startSessionClock(USER, null); // second tab
    startSessionClock(USER, null); // third tab
    jest.advanceTimersByTime(20 * 60_000);

    expect(recorder.messages.filter((m) => m.event === 'session:reminder')).toHaveLength(1);
    recorder.stop();
  });

  it('keeps the clock running while any tab is still open', () => {
    const recorder = capture();
    startSessionClock(USER, 10);
    startSessionClock(USER, null);
    jest.advanceTimersByTime(9 * 60_000);
    closeSession(USER); // one tab closes; the session continues
    jest.advanceTimersByTime(1 * 60_000);

    expect(recorder.messages.filter((m) => m.event === 'session:reminder')).toHaveLength(1);
    expect(sessionMinutes(USER)).toBe(10);
    recorder.stop();
  });

  it('stops when the last tab closes, and starts a fresh clock next time', () => {
    const recorder = capture();
    startSessionClock(USER, 10);
    jest.advanceTimersByTime(9 * 60_000);
    closeSession(USER);
    expect(sessionMinutes(USER)).toBeNull();

    jest.advanceTimersByTime(60 * 60_000);
    expect(recorder.messages.filter((m) => m.event === 'session:reminder')).toHaveLength(0);

    startSessionClock(USER, 10);
    expect(sessionMinutes(USER)).toBe(0);
    recorder.stop();
  });
});
