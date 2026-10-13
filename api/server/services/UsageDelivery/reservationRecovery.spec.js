const { recoverReservations } = require('./reservationRecovery');
test('only source-proven abandoned or durably finished reservations are released', async () => {
  const journal = {
    listReservations: jest.fn(async () => ({
      items: [{ id: 'orphan' }, { id: 'active' }, { id: 'finished' }, { id: 'unknown' }],
      cursor: null,
    })),
    release: jest.fn(),
  };
  const store = {
    readReservationOwners: jest.fn(async () => [
      { reservationId: 'active', durableTerminal: false },
      { reservationId: 'finished', durableTerminal: true },
      { reservationId: 'unknown', durableTerminal: false },
    ]),
  };
  await recoverReservations({ journal, store });
  expect(journal.release.mock.calls).toEqual([['orphan'], ['finished']]);
  expect(store.readReservationOwners).toHaveBeenCalledTimes(1);
});
test('unavailable source evidence never releases capacity', async () => {
  const journal = {
    listReservations: async () => ({ items: [{ id: 'maybe-active' }], cursor: null }),
    release: jest.fn(),
  };
  await expect(
    recoverReservations({
      journal,
      store: {
        readReservationOwners: async () => {
          throw new Error('offline');
        },
      },
    }),
  ).rejects.toThrow('offline');
  expect(journal.release).not.toHaveBeenCalled();
});
