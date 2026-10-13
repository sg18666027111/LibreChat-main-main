/** Reclaim only fenced source owners whose durable business evidence permits it. */
async function recoverReservations({ journal, store, after = null }) {
  const page = await journal.listReservations(after, 100);
  if (!page.items.length) return page.cursor;
  const owners = await store.readReservationOwners(page.items.map((item) => item.id));
  for (const { id } of page.items) {
    const matches = owners.filter((owner) => owner.reservationId === id);
    if (!matches.length || matches.every((owner) => owner.durableTerminal === true))
      await journal.release(id);
  }
  return page.cursor;
}
module.exports = { recoverReservations };
