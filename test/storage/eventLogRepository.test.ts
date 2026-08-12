import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { insertDeal } from '../../src/storage/dealRepository.js';
import { appendEvent, getEventsByDeal } from '../../src/storage/eventLogRepository.js';

describe('eventLogRepository', () => {
  it('round-trips an appended event with a JSON payload', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });

    appendEvent(db, {
      dealId: 'deal-1',
      eventType: 'grid_placed',
      payload: { pEntry: 1901.54 },
      createdAt: 2000,
    });

    const events = getEventsByDeal(db, 'deal-1');
    expect(events).toEqual([
      {
        id: expect.any(Number) as number,
        dealId: 'deal-1',
        eventType: 'grid_placed',
        payloadJson: JSON.stringify({ pEntry: 1901.54 }),
        createdAt: 2000,
      },
    ]);
  });

  it('supports an event with no payload', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });

    appendEvent(db, { dealId: 'deal-1', eventType: 'halted', createdAt: 2000 });

    expect(getEventsByDeal(db, 'deal-1')[0]?.payloadJson).toBeNull();
  });

  it('returns events for a deal in chronological (insertion) order', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });

    appendEvent(db, { dealId: 'deal-1', eventType: 'first', createdAt: 1000 });
    appendEvent(db, { dealId: 'deal-1', eventType: 'second', createdAt: 2000 });
    appendEvent(db, { dealId: 'deal-1', eventType: 'third', createdAt: 3000 });

    expect(getEventsByDeal(db, 'deal-1').map((e) => e.eventType)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('supports a deal-less event (e.g. startup, before any deal exists)', () => {
    const db = openDatabase();
    expect(() => {
      appendEvent(db, { dealId: null, eventType: 'bot_started', createdAt: 500 });
    }).not.toThrow();
  });
});
