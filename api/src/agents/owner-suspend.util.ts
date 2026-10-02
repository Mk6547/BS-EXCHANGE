import { DataSource } from 'typeorm';

/**
 * Block a bet if the player's own owner (their admin or mini admin) has
 * suspended this event for their downline. The master's own suspend lives on the
 * event itself and is enforced separately; this is only the per-owner layer.
 *
 * Standalone function so the sports service can call it with the DataSource it
 * already holds — no new injection, no circular import.
 */
export async function assertOwnerNotSuspended(
  ds: DataSource,
  playerId: string,
  eventId: string,
): Promise<void> {
  const rows = await ds.query(
    `SELECT 1 FROM owner_event_suspend s
       JOIN users u ON u.id = ?
      WHERE s.owner_id = u.owner_id AND s.event_id = ? LIMIT 1`,
    [playerId, eventId],
  ).catch(() => []);
  if (rows.length) {
    throw new Error('This match is suspended for your account.');
  }
}
